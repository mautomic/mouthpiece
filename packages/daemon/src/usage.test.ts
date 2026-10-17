import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChunks } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { billingCycle, MeteredProvider, monthRange, UsageStore } from "./usage.ts";

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
