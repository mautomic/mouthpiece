// install-script.test.ts: dry run only; never executes real installation steps.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-install-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function dryRun(script: string, path = process.env.PATH ?? "") {
  const proc = Bun.spawn(["bash", join(REPO, script)], {
    env: {
      PATH: path,
      HOME: home,
      BUN: process.execPath,
      MOUTHPIECE_DRY_RUN: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    out: await new Response(proc.stdout).text(),
    err: await new Response(proc.stderr).text(),
  };
}

test.each(["install.sh", "uninstall.sh"])("%s parses", async (script) => {
  expect(await Bun.spawn(["bash", "-n", join(REPO, script)]).exited).toBe(0);
});

test("install.sh dry run plans every step and writes nothing", async () => {
  const r = await dryRun("install.sh");
  expect(r.code).toBe(0);
  for (const step of [
    "install",
    "build-hotkeys",
    "install-hooks",
    "install-agent",
    "Mouthpiece is ready",
  ])
    expect(r.out).toContain(step);
  expect(await readdir(home)).toEqual([]);
});

test("uninstall.sh dry run plans removal and writes nothing", async () => {
  const r = await dryRun("uninstall.sh");
  expect(r.code).toBe(0);
  for (const step of ["uninstall-agent", "uninstall-hooks", "auth inworld --delete", "rm -rf"])
    expect(r.out).toContain(step);
  expect(await readdir(home)).toEqual([]);
});

test("uninstall.sh deletes the Keychain key before removing the CLI link it runs through", async () => {
  const r = await dryRun("uninstall.sh");
  const lines = r.out.split("\n");
  const auth = lines.findIndex((l) => l.includes("auth inworld --delete"));
  const unlink = lines.findIndex(
    (l) => l.startsWith("+ rm -f") && l.includes(".local/bin/mouthpiece"),
  );
  expect(auth).toBeGreaterThanOrEqual(0);
  expect(unlink).toBeGreaterThan(auth);
});

/** process.env.PATH without any directory that holds a `codex` or `gemini` (this machine may have them). */
function pathWithoutAgents(): string {
  return (process.env.PATH ?? "")
    .split(":")
    .filter((d) => d && !existsSync(join(d, "codex")) && !existsSync(join(d, "gemini")))
    .join(":");
}

/** A temp dir holding fake executables, prepended to the agent-free PATH. */
async function pathWith(...tools: string[]): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "mp-fakebin-"));
  fakeBins.push(bin);
  for (const tool of tools) {
    await writeFile(join(bin, tool), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, tool), 0o755);
  }
  return `${bin}:${pathWithoutAgents()}`;
}
const fakeBins: string[] = [];
afterEach(async () => {
  for (const bin of fakeBins.splice(0)) await rm(bin, { recursive: true, force: true });
});

test("install.sh installs Codex hooks only when codex is on PATH", async () => {
  const withCodex = await dryRun("install.sh", await pathWith("codex"));
  expect(withCodex.code).toBe(0);
  expect(withCodex.out).toContain("install-hooks --target codex");
  expect(withCodex.out).toContain("/hooks");
  expect(withCodex.out).not.toContain("install-hooks --target gemini");
  expect(await readdir(home)).toEqual([]);

  const without = await dryRun("install.sh", pathWithoutAgents());
  expect(without.code).toBe(0);
  expect(without.out).not.toContain("install-hooks --target codex");
  expect(without.out).not.toContain("install-hooks --target gemini");
  expect(without.out).toContain("install-hooks");
});

test("install.sh installs Gemini hooks only when gemini is on PATH", async () => {
  const r = await dryRun("install.sh", await pathWith("gemini"));
  expect(r.code).toBe(0);
  expect(r.out).toContain("install-hooks --target gemini");
  expect(r.out).not.toContain("install-hooks --target codex");
  expect(await readdir(home)).toEqual([]);
});

test("install.sh treats a failed Codex or Gemini hook install as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  for (const target of ["codex", "gemini"]) {
    const line = script
      .split("\n")
      .find((l) => l.includes(`install-hooks --target ${target}`) && l.includes("run "));
    expect(line).toMatch(new RegExp(`--target ${target} \\|\\| `));
  }
});

test("uninstall.sh dry run removes hooks for all three targets", async () => {
  const r = await dryRun("uninstall.sh", pathWithoutAgents());
  expect(r.code).toBe(0);
  for (const target of ["claude-code", "codex", "gemini"])
    expect(r.out).toContain(`uninstall-hooks --target ${target}`);
  expect(await readdir(home)).toEqual([]);
});

test("install.sh treats a failed hotkey build as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  const line = script.split("\n").find((l) => l.includes("build-hotkeys") && l.includes("run "));
  expect(line).toMatch(/build-hotkeys \|\| /);
});
