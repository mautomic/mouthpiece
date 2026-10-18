import { expect, test } from "bun:test";
import type { UsageReport } from "@mouthpiece/core";
import { PROVIDER_USAGE_TIMEOUT_MS } from "@mouthpiece/daemon";
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
      level: "ok",
    },
  ],
};

function harness(report: UsageReport) {
  const out: string[] = [];
  const err: string[] = [];
  const usageCalls: { month?: string }[] = [];
  const timeouts: (number | undefined)[] = [];
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
        usageCalls.push({ month: opts?.month });
        timeouts.push(opts?.timeoutMs);
        return report;
      },
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
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, usageCalls, timeouts };
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

const FULL: UsageReport = {
  ...REPORT,
  quotas: [
    {
      provider: "inworld",
      limitChars: 100_000,
      usedChars: 85_000,
      remainingChars: 15_000,
      projectedChars: 120_000,
      cycleStart: "2026-10-01T07:00:00.000Z",
      cycleEnd: "2026-11-01T07:00:00.000Z",
      level: "warn",
    },
    {
      provider: "elevenlabs",
      limitChars: 10_000,
      usedChars: 10_400,
      remainingChars: 0,
      projectedChars: 30_000,
      cycleStart: "2026-10-01T07:00:00.000Z",
      cycleEnd: "2026-11-01T07:00:00.000Z",
      level: "exceeded",
      providerReported: {
        usedChars: 10_512,
        limitChars: 10_000,
        resetsAt: "2026-11-03T00:00:00.000Z",
      },
    },
    {
      provider: "openai",
      limitChars: 1_000_000,
      usedChars: 10,
      remainingChars: 999_990,
      projectedChars: 31,
      cycleStart: "2026-10-01T07:00:00.000Z",
      cycleEnd: "2026-11-01T07:00:00.000Z",
      level: "ok",
    },
  ],
  budget: { limitUsd: 20, spentUsd: 17.5, projectedUsd: 54.25, level: "warn" },
  summaries: { calls: 42, failures: 3, medianMs: 1234 },
};

test("usage marks warn and exceeded quotas, prints budget, provider reports, and summaries", async () => {
  const h = harness(FULL);
  expect(await run(["usage"], h.io, h.deps)).toBe(0);
  const lines = h.out.join("").split("\n");
  const quota = (p: string) => lines.find((l) => l.startsWith(`quota ${p}:`)) ?? "";
  expect(quota("inworld")).toEndWith(" [WARN]");
  expect(quota("inworld")).toContain("(85.0%)");
  expect(quota("elevenlabs")).toEndWith(" [EXCEEDED]");
  expect(quota("openai")).not.toContain("[");
  expect(lines).toContain("budget: $17.50 of $20.00 (87.5%), projected $54.25 [WARN]");
  expect(lines).toContain("  provider reports: 10,512 / 10,000 chars, resets 2026-11-03");
  expect(lines).toContain("summaries: 42 calls, 3 failed, median 1,234 ms");
  const err = h.err.join("");
  expect(err).toContain(`warning: ${quota("inworld")}\n`);
  expect(err).toContain(`warning: ${quota("elevenlabs")}\n`);
  expect(err).toContain("warning: budget: $17.50 of $20.00 (87.5%), projected $54.25 [WARN]\n");
  expect(err).not.toContain("openai");
  expect(err.trim().split("\n")).toHaveLength(3);
});

test("provider reports without a reset date omit it", async () => {
  const [, elevenlabs] = FULL.quotas;
  if (!elevenlabs) throw new Error("fixture");
  const h = harness({
    ...REPORT,
    quotas: [{ ...elevenlabs, level: "ok", providerReported: { usedChars: 5, limitChars: 9 } }],
  });
  expect(await run(["usage"], h.io, h.deps)).toBe(0);
  expect(h.out.join("")).toContain("  provider reports: 5 / 9 chars\n");
  expect(h.err).toEqual([]);
});

test("summaries with no calls print no median", async () => {
  const h = harness({ ...REPORT, summaries: { calls: 0, failures: 0, medianMs: null } });
  expect(await run(["usage"], h.io, h.deps)).toBe(0);
  expect(h.out.join("")).toContain("summaries: 0 calls, 0 failed\n");
});

test("an empty report exits 0 with no quota, budget, or warnings", async () => {
  const h = harness({ from: REPORT.from, to: REPORT.to, rows: [], quotas: [] });
  expect(await run(["usage"], h.io, h.deps)).toBe(0);
  const text = h.out.join("");
  expect(text).toContain("provider");
  expect(text).not.toContain("quota");
  expect(text).not.toContain("budget");
  expect(text).not.toContain("summaries");
  expect(h.err).toEqual([]);
});

test("usage waits longer than the daemon's provider usage-report limit", async () => {
  const h = harness(REPORT);
  expect(await run(["usage"], h.io, h.deps)).toBe(0);
  const [timeoutMs] = h.timeouts;
  expect(timeoutMs).toBeGreaterThanOrEqual(8000);
  expect(timeoutMs).toBeGreaterThan(PROVIDER_USAGE_TIMEOUT_MS);
});
