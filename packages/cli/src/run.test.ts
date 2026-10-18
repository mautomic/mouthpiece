import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakEvent } from "@mouthpiece/core";
import { run } from "./run.ts";
import type { CliDeps, CliIO } from "./types.ts";

function harness(
  opts: { stdin?: string; tty?: boolean; fail?: boolean; env?: Record<string, string> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const spoken: SpeakEvent[] = [];
  const execCalls: string[][] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => opts.stdin ?? "",
    stdinIsTTY: opts.tty ?? true,
  };
  const failing = async () => {
    throw new Error("mouthpiece daemon unreachable at http://127.0.0.1:7317");
  };
  const deps: CliDeps = {
    client: {
      speak: opts.fail
        ? failing
        : async (e) => {
            spoken.push(e);
            return { id: "abc" };
          },
      stop: async () => ({ stopped: true, dropped: 2 }),
      skip: async () => ({ skipped: true }),
      health: async () => ({ ok: true, version: "0.1.0", provider: "say", queueDepth: 0 }),
      getMode: async () => ({ default: "summary", overrides: [] }),
      setMode: async () => ({ default: "summary", overrides: [] }),
      replay: async () => ({ id: null }),
      usage: async () => ({ from: "2026-10-01", to: "2026-11-01", rows: [], quotas: [] }),
      voices: async () => ({ providers: [] }),
      status: async () => ({
        version: "0.1.0",
        speaking: false,
        paused: false,
        pauseReasons: [],
        mode: "summary",
        queueDepth: 0,
        provider: "say",
        current: null,
      }),
      pause: async (reason = "user") => ({ paused: true, pauseReasons: [reason] }),
      resume: async () => ({ paused: false, pauseReasons: [] }),
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: opts.env ?? {},
    exec: async (cmd) => {
      execCalls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    },
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, spoken, execCalls };
}

test("say joins positional args", async () => {
  const h = harness();
  expect(await run(["say", "hello", "world", "--label", "web"], h.io, h.deps)).toBe(0);
  expect(h.spoken[0]).toEqual({
    text: "hello world",
    source: "cli",
    label: "web",
    kind: "response",
    format: "markdown",
  });
  expect(h.out.join("")).toContain("abc");
});

test("say reads stdin when piped", async () => {
  const h = harness({ stdin: "from a pipe\n", tty: false });
  expect(await run(["say", "--plain", "--source", "cron", "--kind", "alert"], h.io, h.deps)).toBe(
    0,
  );
  expect(h.spoken[0]).toMatchObject({
    text: "from a pipe",
    source: "cron",
    kind: "alert",
    format: "plain",
  });
});

test("say with no text is a usage error", async () => {
  const h = harness();
  expect(await run(["say"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("nothing to say");
});

test("client errors exit 1 with the message", async () => {
  const h = harness({ fail: true });
  expect(await run(["say", "hi"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("unreachable");
});

test("stop, skip, status", async () => {
  const h = harness();
  expect(await run(["stop"], h.io, h.deps)).toBe(0);
  expect(await run(["skip"], h.io, h.deps)).toBe(0);
  expect(await run(["status"], h.io, h.deps)).toBe(0);
  expect(h.out.join("\n")).toContain('"provider": "say"');
});

test("start launches the daemon", async () => {
  const h = harness();
  expect(await run(["start"], h.io, h.deps)).toBe(0);
  expect(h.err.join("")).toContain("listening on http://127.0.0.1:7317");
});

test("unknown command prints usage", async () => {
  const h = harness();
  expect(await run(["nope"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("usage: mouthpiece");
});

test("mode routes to its command module", async () => {
  const h = harness();
  expect(await run(["mode"], h.io, h.deps)).toBe(0);
  expect(JSON.parse(h.out.join(""))).toEqual({ default: "summary", overrides: [] });
});

test("tail routes to its command (which needs --format)", async () => {
  const h = harness();
  expect(await run(["tail"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("--format");
});

test("voices routes to its command module", async () => {
  const h = harness();
  expect(await run(["voices"], h.io, h.deps)).toBe(0);
  expect(h.err.join("")).not.toContain("not implemented");
});

test("usage text lists say, voices and tail", async () => {
  const h = harness();
  await run([], h.io, h.deps);
  const usage = h.err.join("");
  for (const cmd of ["say", "voices", "tail"]) expect(usage).toContain(`  ${cmd} `);
});

test("usage text shows every flag of say, voices, tail and the hook targets", async () => {
  const h = harness();
  await run([], h.io, h.deps);
  const usage = h.err.join("");
  for (const flag of [
    "--file path",
    "--source s",
    "--label l",
    "--kind response|alert|info",
    "--mode summary|full|off",
    "--voice v",
    "--priority high|normal|low",
    "--plain | --markdown",
    "--fallback-say",
    "voices [--provider x]",
    "tail --format codex|gemini|lines [--path p]",
    "install-hooks [--target claude-code|codex|gemini] [--idle-alerts]",
    "uninstall-hooks [--target claude-code|codex|gemini]",
  ])
    expect(usage).toContain(flag);
});

test.each([["kokoro"], ["pause"], ["resume"]])(
  "%s routes to its (not yet implemented) command",
  async (cmd) => {
    const h = harness();
    expect(await run([cmd], h.io, h.deps)).toBe(1);
    expect(h.err.join("")).toContain(`${cmd} is not implemented`);
  },
);

test("build-helper is an alias of build-hotkeys", async () => {
  const home = await mkdtemp(join(tmpdir(), "mp-run-helper-"));
  try {
    const h = harness({ env: { MOUTHPIECE_HOME: home } });
    expect(await run(["build-helper"], h.io, h.deps)).toBe(0);
    expect(h.execCalls.some((c) => c[0] === "swiftc")).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("usage text lists the phase 4 commands", async () => {
  const h = harness();
  await run([], h.io, h.deps);
  const usage = h.err.join("");
  for (const text of [
    "kokoro install | status | uninstall",
    "pause | resume",
    "send --tmux <target> <text…>",
    "build-hotkeys | build-helper",
  ])
    expect(usage).toContain(text);
});
