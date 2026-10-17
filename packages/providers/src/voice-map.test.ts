import { expect, test } from "bun:test";
import type { ProviderUsage, TtsProvider, VoiceInfo } from "@mouthpiece/core";
import { FakeProvider } from "./fake.ts";
import { VoiceMapProvider } from "./voice-map.ts";

const map = { web: "V-web", api: "V-api" };

test("a mapped label selects the mapped voice", async () => {
  const inner = new FakeProvider();
  await new VoiceMapProvider(inner, map).synthesize("x", { label: "web", tag: "s" });
  expect(inner.options[0]).toMatchObject({ voice: "V-web", label: "web", tag: "s" });
});

test("an explicit voice wins over the map", async () => {
  const inner = new FakeProvider();
  await new VoiceMapProvider(inner, map).synthesize("x", { label: "web", voice: "Explicit" });
  expect(inner.options[0]?.voice).toBe("Explicit");
});

test("an unmapped or missing label passes no voice", async () => {
  const inner = new FakeProvider();
  const p = new VoiceMapProvider(inner, map);
  await p.synthesize("x", { label: "other" });
  await p.synthesize("x");
  await p.synthesize("x", { label: "toString" });
  expect(inner.options.map((o) => o.voice)).toEqual([undefined, undefined, undefined]);
});

test("the signal is passed through", async () => {
  const inner = new FakeProvider();
  const signal = new AbortController().signal;
  await new VoiceMapProvider(inner, map).synthesize("x", { label: "web", signal });
  expect(inner.options[0]?.signal).toBe(signal);
});

test("delegates name, limits, price and cacheKey", () => {
  const inner = new FakeProvider({ name: "inworld", maxCharsPerRequest: 123, cacheKey: "k" });
  const p = new VoiceMapProvider(inner, map);
  expect(p.name).toBe("inworld");
  expect(p.maxCharsPerRequest).toBe(123);
  expect(p.pricePerMillionChars).toBe(inner.pricePerMillionChars);
  expect(p.cacheKey).toBe("k");
});

test("delegates listVoices and usageStatus when the inner provider has them", async () => {
  const voices: VoiceInfo[] = [{ id: "a", name: "A" }];
  const usage: ProviderUsage = { usedChars: 1, limitChars: 2 };
  const inner: TtsProvider = Object.assign(new FakeProvider(), {
    listVoices: async () => voices,
    usageStatus: async () => usage,
  });
  const p = new VoiceMapProvider(inner, {});
  expect(await p.listVoices?.()).toBe(voices);
  expect(await p.usageStatus?.()).toBe(usage);
});

test("lacks listVoices and usageStatus when the inner provider does", () => {
  const p = new VoiceMapProvider(new FakeProvider(), {});
  expect(p.listVoices).toBeUndefined();
  expect(p.usageStatus).toBeUndefined();
});
