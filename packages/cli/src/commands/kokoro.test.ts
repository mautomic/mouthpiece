import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, type Exec } from "@mouthpiece/core";
import type { CliDeps, CliIO } from "../types.ts";
import { kokoroCommand } from "./kokoro.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-kokoro-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface Call {
  cmd: string[];
  opts?: Parameters<Exec>[1];
}

function harness(exec?: Exec) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "",
    stdinIsTTY: true,
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used by kokoro");
  };
  const deps: CliDeps = {
    client: {
      speak: unused,
      stop: unused,
      skip: unused,
      health: unused,
      getMode: unused,
      setMode: unused,
      replay: unused,
      usage: unused,
      voices: unused,
      status: unused,
      pause: unused,
      resume: unused,
      inbox: unused,
      reply: unused,
      submitReply: unused,
      dismissInbox: unused,
    },
    startDaemon: unused,
    env: { MOUTHPIECE_HOME: home, PATH: "/usr/bin" },
    exec: async (cmd, opts) => {
      calls.push({ cmd, opts });
      if (exec) return exec(cmd, opts);
      if (cmd[1]?.endsWith("kokoro-warm.ts"))
        return { code: 0, stdout: '{"loadMs":312,"generateMs":498}\n', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, calls };
}

async function fakeInstall(): Promise<void> {
  const pkg = join(home, "kokoro", "node_modules", "kokoro-js");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ version: "1.2.1" }));
}

test("install creates <home>/kokoro, adds kokoro-js there, warms up, and hints at the chain", async () => {
  const h = harness();
  expect(await kokoroCommand(["install"], h.io, h.deps)).toBe(0);
  const dir = join(home, "kokoro");
  expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({
    name: "mouthpiece-kokoro",
    private: true,
    type: "module",
  });
  expect(h.calls.map((c) => c.cmd)).toEqual([
    ["/bun", "add", "kokoro-js@1.2.1"],
    ["/bun", "/repo/scripts/kokoro-warm.ts"],
  ]);
  expect(h.calls[0]?.opts?.cwd).toBe(dir);
  expect(h.calls[1]?.opts?.env).toMatchObject({ MOUTHPIECE_HOME: home, PATH: "/usr/bin" });
  const out = h.out.join("");
  expect(out).toContain("312");
  expect(out).toContain("498");
  expect(out).toContain('Add "kokoro" to [provider].chain in config.toml');
  expect(h.err).toEqual([]);
});

test("install keeps an existing package.json", async () => {
  const dir = join(home, "kokoro");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), '{"name":"mine"}');
  const h = harness();
  expect(await kokoroCommand(["install"], h.io, h.deps)).toBe(0);
  expect(await readFile(join(dir, "package.json"), "utf8")).toBe('{"name":"mine"}');
});

test("install stops with the error when bun add fails", async () => {
  const h = harness(async () => ({ code: 1, stdout: "", stderr: "error: network down" }));
  expect(await kokoroCommand(["install"], h.io, h.deps)).toBe(1);
  expect(h.calls).toHaveLength(1);
  expect(h.err.join("")).toContain("network down");
  expect(h.out.join("")).not.toContain("[provider].chain");
});

test("install reports a failed warm-up", async () => {
  const h = harness(async (cmd) =>
    cmd[1]?.endsWith("kokoro-warm.ts")
      ? { code: 1, stdout: "", stderr: "model download failed" }
      : { code: 0, stdout: "", stderr: "" },
  );
  expect(await kokoroCommand(["install"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("model download failed");
});

test("a warm-up that printed its timing succeeds even when Bun then crashes on exit", async () => {
  const h = harness(async (cmd) =>
    cmd[1]?.endsWith("kokoro-warm.ts")
      ? {
          code: 134,
          stdout: '{"loadMs":301,"generateMs":455}\n',
          stderr: "panic: A C++ exception occurred\noh no: Bun has crashed.\n",
        }
      : { code: 0, stdout: "", stderr: "" },
  );
  expect(await kokoroCommand(["install"], h.io, h.deps)).toBe(0);
  const out = h.out.join("");
  expect(out).toContain("Kokoro is ready (load 301 ms, first phrase 455 ms)");
  expect(out).toContain('Add "kokoro" to [provider].chain in config.toml');
  // The crash is still reported, as a note.
  expect(h.err.join("")).toContain("exit code 134");
  expect(h.err.join("")).toContain("A C++ exception occurred");
});

test("a warm-up that crashed before printing its timing fails", async () => {
  const h = harness(async (cmd) =>
    cmd[1]?.endsWith("kokoro-warm.ts")
      ? { code: 134, stdout: "loading…\n", stderr: "panic: A C++ exception occurred\n" }
      : { code: 0, stdout: "", stderr: "" },
  );
  expect(await kokoroCommand(["install"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("A C++ exception occurred");
  expect(h.out.join("")).not.toContain("Kokoro is ready");
});

test("a warm-up that exits 0 without a timing line still fails", async () => {
  const h = harness(async (cmd) =>
    cmd[1]?.endsWith("kokoro-warm.ts")
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
  );
  expect(await kokoroCommand(["install"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("Kokoro warm-up failed");
});

// Live: the real warm script against an existing install (MOUTHPIECE_KOKORO_LIVE_DIR, linked as
// <tmp home>/kokoro), offline so nothing is downloaded. It must exit 0 on its own.
const liveDir = process.env.MOUTHPIECE_KOKORO_LIVE_DIR;
test.skipIf(process.env.MOUTHPIECE_LIVE_TESTS !== "1" || !liveDir)(
  "live: the warm script exits 0 with a timing line",
  async () => {
    await symlink(liveDir ?? "", join(home, "kokoro"));
    const script = join(import.meta.dir, "../../../../scripts/kokoro-warm.ts");
    const r = await defaultExec([process.execPath, script], {
      env: { ...process.env, MOUTHPIECE_HOME: home, MOUTHPIECE_KOKORO_OFFLINE: "1" },
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      loadMs: expect.any(Number),
      generateMs: expect.any(Number),
    });
  },
  60_000,
);

test("status reports not installed", async () => {
  const h = harness();
  expect(await kokoroCommand(["status"], h.io, h.deps)).toBe(0);
  expect(h.out.join("")).toContain("not installed");
  expect(h.out.join("")).toContain("mouthpiece kokoro install");
  expect(h.calls).toEqual([]);
});

test("status reports the install, version and model cache size", async () => {
  await fakeInstall();
  const hf = join(home, "kokoro", "hf", "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx");
  await mkdir(hf, { recursive: true });
  await writeFile(join(hf, "model_quantized.onnx"), new Uint8Array(3 * 1024 * 1024));
  const h = harness();
  expect(await kokoroCommand(["status"], h.io, h.deps)).toBe(0);
  const out = h.out.join("");
  expect(out).toContain("installed");
  expect(out).not.toContain("not installed");
  expect(out).toContain("1.2.1");
  expect(out).toContain(join(home, "kokoro"));
  expect(out).toContain("3.0 MB");
});

test("uninstall removes exactly <home>/kokoro", async () => {
  await fakeInstall();
  const h = harness();
  expect(await kokoroCommand(["uninstall"], h.io, h.deps)).toBe(0);
  expect(h.calls.map((c) => c.cmd)).toEqual([["rm", "-rf", join(home, "kokoro")]]);
  expect(h.out.join("")).toContain("Removed");
});

test("uninstall with the real exec deletes <home>/kokoro and nothing else", async () => {
  await fakeInstall();
  await writeFile(join(home, "token"), "t");
  await mkdir(join(home, "kokoro-notes"));
  const h = harness(defaultExec);
  expect(await kokoroCommand(["uninstall"], h.io, h.deps)).toBe(0);
  expect((await readdir(home)).sort()).toEqual(["kokoro-notes", "token"]);
});

test("uninstall fails loudly when rm fails", async () => {
  const h = harness(async () => ({ code: 1, stdout: "", stderr: "permission denied" }));
  expect(await kokoroCommand(["uninstall"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("permission denied");
});

test("an unknown or missing subcommand prints usage and exits 2", async () => {
  for (const args of [[], ["upgrade"]]) {
    const h = harness();
    expect(await kokoroCommand(args, h.io, h.deps)).toBe(2);
    expect(h.err.join("")).toContain("kokoro install | status | uninstall");
    expect(h.calls).toEqual([]);
  }
});
