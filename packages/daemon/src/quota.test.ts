import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, collectChunks, DEFAULT_CONFIG } from "@mouthpiece/core";
import { FakeProvider, FallbackProvider } from "@mouthpiece/providers";
import { QuotaExceededError, QuotaGatedProvider, QuotaGuard } from "./quota.ts";
import { UsageStore } from "./usage.ts";

let dir: string;
let clock: Date;
let store: UsageStore;
let config: Config;
let notices: string[];
let logs: Record<string, unknown>[];

const openStore = () => new UsageStore(join(dir, "usage.sqlite"), () => clock.getTime());
const newGuard = () =>
  new QuotaGuard({
    store,
    config: () => config,
    now: () => clock,
    notify: (text) => notices.push(text),
    log: (r) => logs.push(r),
  });
const use = (provider: string, chars: number, costUsd = 0) =>
  store.record({ provider, source: "test", chars, cached: false, costUsd });
const priced = (name: string) =>
  Object.assign(new FakeProvider({ name }), { pricePerMillionChars: 15 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-quota-"));
  clock = new Date(2026, 9, 10, 12);
  store = openStore();
  config = structuredClone(DEFAULT_CONFIG);
  config.usage.quotas = { inworld: { chars: 100 } };
  notices = [];
  logs = [];
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("crossing the warn threshold notifies once; further use below 100% does not repeat it", () => {
  const guard = newGuard();
  use("inworld", 50);
  guard.afterUse("inworld");
  expect(notices).toEqual([]);
  use("inworld", 30);
  guard.afterUse("inworld");
  expect(notices).toEqual(["Inworld has used 80% of its monthly quota."]);
  use("inworld", 5);
  guard.afterUse("inworld");
  expect(notices).toHaveLength(1);
  expect(guard.isBlocked("inworld", true)).toBe(false);
});

test("the warn percentage is the actual share used", () => {
  use("inworld", 85);
  newGuard().afterUse("inworld");
  expect(notices).toEqual(["Inworld has used 85% of its monthly quota."]);
});

test("reaching 100% notifies 'used up' once and blocks the provider", () => {
  const guard = newGuard();
  use("inworld", 85);
  guard.afterUse("inworld");
  expect(guard.isBlocked("inworld", true)).toBe(false);
  use("inworld", 15);
  guard.afterUse("inworld");
  guard.afterUse("inworld");
  expect(notices).toEqual([
    "Inworld has used 85% of its monthly quota.",
    "Inworld quota is used up. Using the system voice until Nov 1.",
  ]);
  expect(guard.isBlocked("inworld", true)).toBe(true);
  expect(guard.isBlocked("openai", true)).toBe(false);
});

test("jumping straight past 100% speaks only the 'used up' notice", () => {
  use("inworld", 120);
  newGuard().afterUse("inworld");
  expect(notices).toEqual(["Inworld quota is used up. Using the system voice until Nov 1."]);
});

test("a guard recreated on the same db after a restart does not repeat notices", () => {
  use("inworld", 80);
  newGuard().afterUse("inworld");
  expect(notices).toHaveLength(1);
  store.close();
  store = openStore();
  const restarted = newGuard();
  use("inworld", 1);
  restarted.afterUse("inworld");
  expect(notices).toHaveLength(1);
  use("inworld", 19);
  restarted.afterUse("inworld");
  expect(notices).toHaveLength(2);
  store.close();
  store = openStore();
  const again = newGuard();
  again.afterUse("inworld");
  expect(notices).toHaveLength(2);
  expect(again.isBlocked("inworld", true)).toBe(true);
});

test("a new billing cycle unblocks the provider and its warn can fire again", () => {
  const guard = newGuard();
  use("inworld", 100);
  guard.afterUse("inworld");
  expect(guard.isBlocked("inworld", true)).toBe(true);
  clock = new Date(2026, 10, 1, 0, 0, 1);
  expect(guard.isBlocked("inworld", true)).toBe(false);
  use("inworld", 80);
  guard.afterUse("inworld");
  expect(notices).toEqual([
    "Inworld quota is used up. Using the system voice until Nov 1.",
    "Inworld has used 80% of its monthly quota.",
  ]);
});

test("the cycle follows usage.resetDay", () => {
  config.usage.resetDay = 15;
  const guard = newGuard();
  use("inworld", 100);
  guard.afterUse("inworld");
  expect(notices).toEqual(["Inworld quota is used up. Using the system voice until Oct 15."]);
  clock = new Date(2026, 9, 15, 0, 0, 1);
  expect(guard.isBlocked("inworld", true)).toBe(false);
});

test("warn and exceeded levels respect usage.warnAt and live config changes", () => {
  config.usage.warnAt = 0.5;
  const guard = newGuard();
  use("inworld", 50);
  guard.afterUse("inworld");
  expect(notices).toEqual(["Inworld has used 50% of its monthly quota."]);
  use("inworld", 50);
  expect(guard.isBlocked("inworld", true)).toBe(true);
  // Hot reload: a bigger quota lifts the block without a restart.
  config = { ...config, usage: { ...config.usage, quotas: { inworld: { chars: 1000 } } } };
  expect(guard.isBlocked("inworld", true)).toBe(false);
  // Removing the quota entirely also lifts it.
  config = { ...config, usage: { ...config.usage, quotas: {} } };
  guard.afterUse("inworld");
  expect(guard.isBlocked("inworld", true)).toBe(false);
});

test("budget warn and exceeded notify once each and block every paid provider, never free ones", () => {
  config.usage.quotas = {};
  config.usage.monthlyBudgetUsd = 10;
  const guard = newGuard();
  use("openai", 1000, 8.5);
  guard.afterUse("openai");
  guard.afterUse("openai");
  expect(notices).toEqual(["Mouthpiece has used 85% of its $10 monthly budget."]);
  expect(guard.isBlocked("openai", true)).toBe(false);
  use("inworld", 1000, 1.5);
  guard.afterUse("inworld");
  guard.afterUse("openai");
  expect(notices).toEqual([
    "Mouthpiece has used 85% of its $10 monthly budget.",
    "Mouthpiece's $10 monthly budget is used up. Using the system voice until Nov 1.",
  ]);
  expect(guard.isBlocked("openai", true)).toBe(true);
  expect(guard.isBlocked("inworld", true)).toBe(true);
  expect(guard.isBlocked("deepgram", true)).toBe(true);
  expect(guard.isBlocked("say", false)).toBe(false);
  clock = new Date(2026, 10, 2);
  expect(guard.isBlocked("openai", true)).toBe(false);
});

test("a fractional budget is spoken with cents", () => {
  config.usage.quotas = {};
  config.usage.monthlyBudgetUsd = 2.5;
  use("openai", 1000, 2);
  newGuard().afterUse("openai");
  expect(notices).toEqual(["Mouthpiece has used 80% of its $2.50 monthly budget."]);
});

test("say is never blocked, even with its own exhausted quota", () => {
  config.usage.quotas = { say: { chars: 200 } };
  const guard = newGuard();
  use("say", 160);
  guard.afterUse("say", false);
  use("say", 40);
  guard.afterUse("say", false);
  expect(notices).toEqual([
    "Say has used 80% of its monthly quota.",
    "Say has used 100% of its monthly quota.",
  ]);
  expect(guard.isBlocked("say", false)).toBe(false);
});

test("multi-word and branded provider names read naturally", () => {
  config.usage.quotas = { elevenlabs: { chars: 100 }, openai: { chars: 100 } };
  const guard = newGuard();
  use("elevenlabs", 80);
  use("openai", 80);
  guard.afterUse("elevenlabs");
  guard.afterUse("openai");
  expect(notices).toEqual([
    "ElevenLabs has used 80% of its monthly quota.",
    "OpenAI has used 80% of its monthly quota.",
  ]);
});

test("a notify that throws is logged, not propagated", () => {
  const guard = new QuotaGuard({
    store,
    config: () => config,
    now: () => clock,
    notify: () => {
      throw new Error("queue closed");
    },
    log: (r) => logs.push(r),
  });
  use("inworld", 90);
  expect(() => guard.afterUse("inworld")).not.toThrow();
  expect(logs.some((r) => r.level === "error" && String(r.error).includes("queue closed"))).toBe(
    true,
  );
});

test("QuotaGatedProvider throws QuotaExceededError without calling inner when blocked", async () => {
  const inner = priced("inworld");
  const gated = new QuotaGatedProvider(inner, newGuard());
  use("inworld", 100);
  const error = await gated.synthesize("hello").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(QuotaExceededError);
  expect((error as QuotaExceededError).provider).toBe("inworld");
  expect(inner.calls).toEqual([]);
});

test("QuotaGatedProvider calls inner, then afterUse, and passes options through", async () => {
  const events: string[] = [];
  const guard = {
    isBlocked: (provider: string, paid: boolean) => {
      events.push(`isBlocked:${provider}:${paid}`);
      return false;
    },
    afterUse: (provider: string, paid?: boolean) => {
      events.push(`afterUse:${provider}:${paid}`);
    },
  };
  const inner = priced("inworld");
  const original = inner.synthesize.bind(inner);
  inner.synthesize = async (text, opts) => {
    events.push("inner");
    return original(text, opts);
  };
  const gated = new QuotaGatedProvider(inner, guard);
  const clip = await gated.synthesize("hello", { voice: "V", tag: "src" });
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("hello");
  expect(events).toEqual(["isBlocked:inworld:true", "inner", "afterUse:inworld:true"]);
  expect(inner.options[0]).toMatchObject({ voice: "V", tag: "src" });
});

test("QuotaGatedProvider skips afterUse when inner fails", async () => {
  const calls: string[] = [];
  const guard = { isBlocked: () => false, afterUse: (p: string) => void calls.push(p) };
  const gated = new QuotaGatedProvider(new FakeProvider({ failWith: new Error("boom") }), guard);
  await expect(gated.synthesize("hello")).rejects.toThrow("boom");
  expect(calls).toEqual([]);
});

test("QuotaGatedProvider delegates the provider's other members", async () => {
  const inner = Object.assign(
    new FakeProvider({ name: "x", maxCharsPerRequest: 77, cacheKey: "k" }),
    {
      pricePerMillionChars: 30,
      listVoices: async () => [{ id: "v1", name: "Voice 1" }],
      usageStatus: async () => ({ usedChars: 1, limitChars: 2 }),
    },
  );
  const gated = new QuotaGatedProvider(inner, newGuard());
  expect(gated.name).toBe("x");
  expect(gated.maxCharsPerRequest).toBe(77);
  expect(gated.pricePerMillionChars).toBe(30);
  expect(gated.cacheKey).toBe("k");
  expect(await gated.listVoices?.()).toEqual([{ id: "v1", name: "Voice 1" }]);
  expect(await gated.usageStatus?.()).toEqual({ usedChars: 1, limitChars: 2 });
  const bare = new QuotaGatedProvider(new FakeProvider(), newGuard());
  expect(bare.listVoices).toBeUndefined();
  expect(bare.usageStatus).toBeUndefined();
  expect(bare.cacheKey).toBeUndefined();
});

test("a fallback chain falls through to say when the paid provider is blocked", async () => {
  const guard = newGuard();
  const inworld = priced("inworld");
  const say = new FakeProvider({ name: "say" });
  const chain = new FallbackProvider(
    [new QuotaGatedProvider(inworld, guard), new QuotaGatedProvider(say, guard)],
    { firstByteTimeoutMs: 1000 },
  );
  await collectChunks((await chain.synthesize("before")).chunks);
  expect(inworld.calls).toEqual(["before"]);
  use("inworld", 100);
  const fellBack: string[] = [];
  const chain2 = new FallbackProvider(
    [new QuotaGatedProvider(inworld, guard), new QuotaGatedProvider(say, guard)],
    { firstByteTimeoutMs: 1000, onFallback: (from) => fellBack.push(from) },
  );
  const clip = await chain2.synthesize("after");
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("after");
  expect(inworld.calls).toEqual(["before"]);
  expect(say.calls).toEqual(["after"]);
  expect(fellBack).toEqual(["inworld"]);
});
