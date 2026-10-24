import { expect, test } from "bun:test";
import type { ModeRequest } from "@mouthpiece/core";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const setModeCalls: ModeRequest[] = [];
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
      getMode: async () => ({
        default: "summary",
        overrides: [{ source: "cron", mode: "full" }],
      }),
      setMode: async (req) => {
        setModeCalls.push(req);
        return { default: req.mode ?? "full", overrides: [] };
      },
      replay: async () => ({ id: null }),
      usage: async () => ({ from: "", to: "", rows: [], quotas: [] }),
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
      pause: async () => ({ paused: true, pauseReasons: ["user"] }),
      resume: async () => ({ paused: false, pauseReasons: [] }),
      voices: async () => ({ providers: [] }),
      inbox: async () => ({ enabled: false, entries: [] }),
      reply: async () => ({ status: "submitted" }),
      submitReply: async () => ({ status: "submitted" }),
      dismissInbox: async () => ({ dismissed: 0 }),
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, setModeCalls };
}

test("mode with no action prints the state", async () => {
  const h = harness();
  expect(await run(["mode"], h.io, h.deps)).toBe(0);
  expect(JSON.parse(h.out.join(""))).toEqual({
    default: "summary",
    overrides: [{ source: "cron", mode: "full" }],
  });
  expect(h.setModeCalls).toEqual([]);
});

test("mode <mode> --source sets a source override", async () => {
  const h = harness();
  expect(await run(["mode", "full", "--source", "claude-code"], h.io, h.deps)).toBe(0);
  expect(h.setModeCalls).toEqual([{ mode: "full", source: "claude-code" }]);
  expect(JSON.parse(h.out.join(""))).toEqual({ default: "full", overrides: [] });
});

test("mode toggle", async () => {
  const h = harness();
  expect(await run(["mode", "toggle"], h.io, h.deps)).toBe(0);
  expect(h.setModeCalls).toEqual([{ toggle: true }]);
});

test("mode clear with a conversation scope", async () => {
  const h = harness();
  expect(await run(["mode", "clear", "--source", "x", "--conversation", "c"], h.io, h.deps)).toBe(
    0,
  );
  expect(h.setModeCalls).toEqual([{ clear: true, source: "x", conversationId: "c" }]);
});

test("unknown mode is a usage error", async () => {
  const h = harness();
  expect(await run(["mode", "loud"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("summary, summary-short, full, off");
  expect(h.setModeCalls).toEqual([]);
});
