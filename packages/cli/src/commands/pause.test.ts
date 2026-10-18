import { expect, test } from "bun:test";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "",
    stdinIsTTY: true,
  };
  const deps: CliDeps = {
    client: {
      speak: async () => ({ id: "abc" }),
      stop: async () => ({ stopped: true, dropped: 0 }),
      skip: async () => ({ skipped: true }),
      health: async () => ({ ok: true, version: "0.1.0", provider: "say", queueDepth: 0 }),
      getMode: async () => ({ default: "summary", overrides: [] }),
      setMode: async () => ({ default: "summary", overrides: [] }),
      replay: async () => ({ id: null }),
      usage: async () => ({ from: "", to: "", rows: [], quotas: [] }),
      voices: async () => ({ providers: [] }),
      inbox: async () => ({ enabled: false, entries: [] }),
      reply: async () => ({ status: "submitted" }),
      submitReply: async () => ({ status: "submitted" }),
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
      pause: async (reason = "missing") => {
        calls.push(`pause:${reason}`);
        return { paused: true, pauseReasons: [reason] };
      },
      resume: async (reason = "missing") => {
        calls.push(`resume:${reason}`);
        return { paused: false, pauseReasons: [] };
      },
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, calls };
}

test("pause uses reason user by default and prints the pause state (US-022)", async () => {
  const h = harness();
  expect(await run(["pause"], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual(["pause:user"]);
  expect(JSON.parse(h.out.join(""))).toEqual({ paused: true, pauseReasons: ["user"] });
});

test("resume uses reason user by default", async () => {
  const h = harness();
  expect(await run(["resume"], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual(["resume:user"]);
  expect(JSON.parse(h.out.join(""))).toEqual({ paused: false, pauseReasons: [] });
});

test("--reason picks the reason", async () => {
  const h = harness();
  expect(await run(["pause", "--reason", "mic"], h.io, h.deps)).toBe(0);
  expect(await run(["resume", "--reason=mic"], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual(["pause:mic", "resume:mic"]);
});

test("unknown flags and stray arguments are errors", async () => {
  const h = harness();
  expect(await run(["pause", "--nope"], h.io, h.deps)).toBe(1);
  expect(await run(["resume", "mic"], h.io, h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
});

test("a daemon error (e.g. a bad reason) exits 1 with its message", async () => {
  const h = harness();
  h.deps.client = {
    ...h.deps.client,
    pause: async () => {
      throw new Error("reason must match ^[a-z][a-z0-9-]{0,31}$");
    },
  };
  expect(await run(["pause", "--reason", "Bad"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("reason must match");
});
