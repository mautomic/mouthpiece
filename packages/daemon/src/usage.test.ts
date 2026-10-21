import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChunks } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { billingCycle, levelFor, MeteredProvider, monthRange, UsageStore } from "./usage.ts";

let dir: string;
let store: UsageStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-usage-"));
  store = new UsageStore(join(dir, "usage.sqlite"), () => new Date(2026, 9, 10).getTime());
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("billingCycle and monthRange", () => {
  expect(billingCycle(new Date(2026, 9, 10), 15)).toEqual({
    start: new Date(2026, 8, 15),
    end: new Date(2026, 9, 15),
  });
  expect(billingCycle(new Date(2026, 9, 20), 15)).toEqual({
    start: new Date(2026, 9, 15),
    end: new Date(2026, 10, 15),
  });
  expect(monthRange("2026-12")).toEqual({
    start: new Date(2026, 11, 1),
    end: new Date(2027, 0, 1),
  });
  expect(() => monthRange("2026-13")).toThrow();
});

test("metered provider records billed chars, cost, and cache hits by source", async () => {
  const priced = Object.assign(new FakeProvider({ name: "inworld" }), { pricePerMillionChars: 15 });
  const metered = new MeteredProvider(priced, store);
  await collectChunks((await metered.synthesize("x".repeat(1000), { tag: "claude-code" })).chunks);
  store.record({
    provider: "inworld",
    source: "claude-code",
    chars: 500,
    cached: true,
    costUsd: 0,
  });
  const report = store.report({
    from: new Date(2026, 9, 1),
    to: new Date(2026, 10, 1),
    quotas: { inworld: { chars: 10_000 } },
    resetDay: 1,
    now: new Date(2026, 9, 10),
  });
  expect(report.rows).toEqual([
    {
      provider: "inworld",
      source: "claude-code",
      requests: 2,
      chars: 1000,
      cacheHits: 1,
      costUsd: 0.015,
    },
  ]);
  expect(report.quotas[0]).toMatchObject({
    provider: "inworld",
    limitChars: 10_000,
    usedChars: 1000,
    remainingChars: 9000,
  });
  expect(report.quotas[0]?.projectedChars).toBeGreaterThan(1000);
});

test("sources() lists every distinct metered source, sorted", () => {
  expect(store.sources()).toEqual([]);
  store.record({ provider: "say", source: "devin", chars: 1, cached: false, costUsd: 0 });
  store.record({ provider: "say", source: "codex", chars: 1, cached: false, costUsd: 0 });
  store.record({ provider: "kokoro", source: "codex", chars: 1, cached: true, costUsd: 0 });
  expect(store.sources()).toEqual(["codex", "devin"]);
});

test("untagged synthesis is attributed to 'unknown'", async () => {
  await collectChunks(
    (await new MeteredProvider(new FakeProvider(), store).synthesize("hi")).chunks,
  );
  const r = store.report({
    from: new Date(2026, 0, 1),
    to: new Date(2027, 0, 1),
    quotas: {},
    resetDay: 1,
    now: new Date(2026, 9, 10),
  });
  expect(r.rows[0]).toMatchObject({ provider: "fake", source: "unknown", chars: 2 });
});

const OCT = { from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) };
const reportOpts = { ...OCT, quotas: {}, resetDay: 1, now: new Date(2026, 9, 10), warnAt: 0.8 };

test("levelFor boundaries", () => {
  expect(levelFor(79, 100, 0.8)).toBe("ok");
  expect(levelFor(80, 100, 0.8)).toBe("warn");
  expect(levelFor(99.99, 100, 0.8)).toBe("warn");
  expect(levelFor(100, 100, 0.8)).toBe("exceeded");
  expect(levelFor(150, 100, 0.8)).toBe("exceeded");
  expect(levelFor(0.79, 1, 0.8)).toBe("ok");
  expect(levelFor(0.8, 1, 0.8)).toBe("warn");
  expect(levelFor(1, 1, 0.8)).toBe("exceeded");
  expect(levelFor(50, 100, 0.5)).toBe("warn");
});

test("quota level follows warnAt", () => {
  store.record({ provider: "inworld", source: "s", chars: 60, cached: false, costUsd: 0 });
  const quotas = { inworld: { chars: 100 } };
  expect(store.report({ ...reportOpts, quotas }).quotas[0]?.level).toBe("ok");
  expect(store.report({ ...reportOpts, quotas, warnAt: 0.5 }).quotas[0]?.level).toBe("warn");
  store.record({ provider: "inworld", source: "s", chars: 40, cached: false, costUsd: 0 });
  expect(store.report({ ...reportOpts, quotas }).quotas[0]?.level).toBe("exceeded");
});

test("markNotice is true once per provider, cycle and level, and persists across reopen", () => {
  const cycle = new Date(2026, 9, 1);
  expect(store.markNotice("inworld", cycle, "warn")).toBe(true);
  expect(store.markNotice("inworld", cycle, "warn")).toBe(false);
  expect(store.markNotice("inworld", cycle, "exceeded")).toBe(true);
  expect(store.markNotice("inworld", new Date(2026, 10, 1), "warn")).toBe(true);
  expect(store.markNotice("*budget", cycle, "warn")).toBe(true);
  store.close();
  store = new UsageStore(join(dir, "usage.sqlite"), () => new Date(2026, 9, 10).getTime());
  expect(store.markNotice("inworld", cycle, "warn")).toBe(false);
  expect(store.markNotice("inworld", cycle, "exceeded")).toBe(false);
  expect(store.markNotice("*budget", cycle, "warn")).toBe(false);
});

test("usedChars excludes cache hits and spentUsd sums cost, both within the range", () => {
  let t = new Date(2026, 9, 10).getTime();
  const s = new UsageStore(join(dir, "range.sqlite"), () => t);
  s.record({ provider: "inworld", source: "a", chars: 100, cached: false, costUsd: 0.5 });
  s.record({ provider: "inworld", source: "a", chars: 70, cached: true, costUsd: 0 });
  s.record({ provider: "openai", source: "a", chars: 30, cached: false, costUsd: 0.25 });
  t = new Date(2026, 10, 2).getTime();
  s.record({ provider: "inworld", source: "a", chars: 999, cached: false, costUsd: 9 });
  expect(s.usedChars("inworld", OCT.from, OCT.to)).toBe(100);
  expect(s.usedChars("openai", OCT.from, OCT.to)).toBe(30);
  expect(s.usedChars("deepgram", OCT.from, OCT.to)).toBe(0);
  expect(s.spentUsd(OCT.from, OCT.to)).toBeCloseTo(0.75, 9);
  expect(s.spentUsd(new Date(2027, 0, 1), new Date(2027, 1, 1))).toBe(0);
  s.close();
});

test("recordSummary feeds summary stats; medianMs is null without calls", () => {
  expect(store.report(reportOpts).summaries).toEqual({ calls: 0, failures: 0, medianMs: null });
  store.recordSummary({ backend: "claude-cli", ms: 900, charsIn: 4000, charsOut: 200, ok: true });
  store.recordSummary({ backend: "claude-cli", ms: 100, charsIn: 4000, charsOut: 0, ok: false });
  store.recordSummary({ backend: "claude-cli", ms: 300, charsIn: 2000, charsOut: 150, ok: true });
  expect(store.report(reportOpts).summaries).toEqual({ calls: 3, failures: 1, medianMs: 300 });
  store.recordSummary({ backend: "claude-cli", ms: 500, charsIn: 2000, charsOut: 150, ok: true });
  expect(store.report(reportOpts).summaries).toEqual({ calls: 4, failures: 1, medianMs: 400 });
  // Outside the report range.
  expect(
    store.report({ ...reportOpts, from: new Date(2026, 10, 1), to: new Date(2026, 11, 1) })
      .summaries,
  ).toEqual({ calls: 0, failures: 0, medianMs: null });
});

test("report includes budget only when configured", () => {
  store.record({ provider: "inworld", source: "s", chars: 1000, cached: false, costUsd: 4.5 });
  store.record({ provider: "openai", source: "s", chars: 1000, cached: false, costUsd: 4 });
  expect(store.report(reportOpts).budget).toBeUndefined();
  const budget = store.report({ ...reportOpts, monthlyBudgetUsd: 10 }).budget;
  expect(budget).toMatchObject({ limitUsd: 10, level: "warn" });
  expect(budget?.spentUsd).toBeCloseTo(8.5, 9);
  // 8.5 spent in 9 elapsed days of a 31-day cycle.
  expect(budget?.projectedUsd).toBeCloseTo((8.5 / 9) * 31, 2);
  expect(store.report({ ...reportOpts, monthlyBudgetUsd: 8 }).budget?.level).toBe("exceeded");
  expect(store.report({ ...reportOpts, monthlyBudgetUsd: 100 }).budget?.level).toBe("ok");
});

test("report includes providerReported when passed", () => {
  const reported = { usedChars: 12_345, limitChars: 100_000, resetsAt: "2026-11-01T00:00:00.000Z" };
  const r = store.report({
    ...reportOpts,
    quotas: { elevenlabs: { chars: 100_000 }, inworld: { chars: 10 } },
    providerUsage: { elevenlabs: reported },
  });
  expect(r.quotas.find((q) => q.provider === "elevenlabs")?.providerReported).toEqual(reported);
  expect(r.quotas.find((q) => q.provider === "inworld")?.providerReported).toBeUndefined();
  expect(store.report(reportOpts).quotas).toEqual([]);
});
