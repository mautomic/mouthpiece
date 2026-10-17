import { expect, test } from "bun:test";
import type { UsageReport } from "@mouthpiece/core";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

const REPORT: UsageReport = {
  from: "2026-10-01T07:00:00.000Z",
  to: "2026-11-01T07:00:00.000Z",
  rows: [
    {
      provider: "inworld",
      source: "claude-code",
      requests: 12,
      chars: 4200,
      cacheHits: 3,
      costUsd: 0.063,
    },
    { provider: "say", source: "cron", requests: 2, chars: 80, cacheHits: 0, costUsd: 0 },
  ],
  quotas: [
    {
      provider: "inworld",
      limitChars: 1_000_000,
      usedChars: 4200,
      remainingChars: 995_800,
      projectedChars: 13_020,
      cycleStart: "2026-10-01T07:00:00.000Z",
      cycleEnd: "2026-11-01T07:00:00.000Z",
    },
  ],
};

function harness(report: UsageReport) {
  const out: string[] = [];
  const err: string[] = [];
  const usageCalls: { month?: string }[] = [];
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
      usage: async (opts) => {
        usageCalls.push({ ...opts });
        return report;
      },
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, usageCalls };
}

test("usage --month passes the month and prints rows, cost, and quota", async () => {
  const h = harness(REPORT);
  expect(await run(["usage", "--month", "2026-10"], h.io, h.deps)).toBe(0);
  expect(h.usageCalls).toEqual([{ month: "2026-10" }]);
  const text = h.out.join("");
  expect(text).toContain("inworld");
  expect(text).toContain("claude-code");
  expect(text).toContain("cron");
  expect(text).toContain("$0.06");
  expect(text).toMatch(/quota inworld: 4,200 \/ 1,000,000 chars/);
});

test("usage without --month uses the current cycle and prints no quota line without quotas", async () => {
  const h = harness({ ...REPORT, quotas: [] });
  expect(await run(["usage"], h.io, h.deps)).toBe(0);
  expect(h.usageCalls).toEqual([{}]);
  expect(h.out.join("")).not.toContain("quota");
});
