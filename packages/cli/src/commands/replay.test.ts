import { expect, test } from "bun:test";
import type { ReplayRequest, ReplayResponse } from "@mouthpiece/core";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

function harness(response: ReplayResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const replayCalls: ReplayRequest[] = [];
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
      replay: async (req) => {
        replayCalls.push(req ?? {});
        return response;
      },
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
  return { io, deps, out, err, replayCalls };
}

test("replay --full asks for the full text and prints the id", async () => {
  const h = harness({ id: "r-1" });
  expect(await run(["replay", "--full"], h.io, h.deps)).toBe(0);
  expect(h.replayCalls).toEqual([{ full: true }]);
  expect(JSON.parse(h.out.join(""))).toEqual({ id: "r-1" });
});

test("replay without --full replays what was spoken", async () => {
  const h = harness({ id: "r-2" });
  expect(await run(["replay"], h.io, h.deps)).toBe(0);
  expect(h.replayCalls).toEqual([{ full: false }]);
});

test("nothing to replay exits 1", async () => {
  const h = harness({ id: null });
  expect(await run(["replay"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("nothing to replay");
  expect(h.out).toEqual([]);
});
