import { expect, test } from "bun:test";
import { collectChunks, type TtsProvider } from "@mouthpiece/core";
import { FakeProvider } from "./fake.ts";
import { FallbackProvider } from "./fallback.ts";

const decode = async (p: TtsProvider, text: string) =>
  new TextDecoder().decode(await collectChunks((await p.synthesize(text)).chunks));

test("uses the first provider when it works", async () => {
  const a = new FakeProvider({ name: "a" });
  const b = new FakeProvider({ name: "b" });
  const chain = new FallbackProvider([a, b], { firstByteTimeoutMs: 1000 });
  expect(await decode(chain, "hi")).toBe("hi");
  expect(b.calls).toEqual([]);
  expect(chain.name).toBe("a>b");
});

test("falls back on error and reports it", async () => {
  const fallbacks: string[] = [];
  const chain = new FallbackProvider(
    [new FakeProvider({ name: "a", failWith: new Error("boom") }), new FakeProvider({ name: "b" })],
    { firstByteTimeoutMs: 1000, onFallback: (from) => fallbacks.push(from) },
  );
  expect(await decode(chain, "hi")).toBe("hi");
  expect(fallbacks).toEqual(["a"]);
});

test("falls back when the first byte takes too long", async () => {
  const chain = new FallbackProvider(
    [new FakeProvider({ name: "slow", delayMs: 5000 }), new FakeProvider({ name: "b" })],
    { firstByteTimeoutMs: 50 },
  );
  const started = performance.now();
  expect(await decode(chain, "hi")).toBe("hi");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("throws the last error when all fail", async () => {
  const chain = new FallbackProvider(
    [
      new FakeProvider({ failWith: new Error("one") }),
      new FakeProvider({ failWith: new Error("two") }),
    ],
    { firstByteTimeoutMs: 1000 },
  );
  await expect(chain.synthesize("hi")).rejects.toThrow("two");
});

test("caller abort is not treated as a provider failure", async () => {
  const b = new FakeProvider({ name: "b" });
  const chain = new FallbackProvider([new FakeProvider({ name: "a", delayMs: 5000 }), b], {
    firstByteTimeoutMs: 10_000,
  });
  const controller = new AbortController();
  const p = chain.synthesize("hi", { signal: controller.signal });
  controller.abort();
  await expect(p).rejects.toBeDefined();
  expect(b.calls).toEqual([]);
});

test("maxCharsPerRequest is the minimum; empty chain is an error", () => {
  const chain = new FallbackProvider(
    [
      new FakeProvider({ maxCharsPerRequest: 2000 }),
      new FakeProvider({ maxCharsPerRequest: 4000 }),
    ],
    { firstByteTimeoutMs: 1 },
  );
  expect(chain.maxCharsPerRequest).toBe(2000);
  expect(() => new FallbackProvider([], { firstByteTimeoutMs: 1 })).toThrow();
});

test("the last provider has no first-byte timeout because nothing follows it", async () => {
  const fallbacks: string[] = [];
  const only = new FallbackProvider([new FakeProvider({ name: "slow", delayMs: 120 })], {
    firstByteTimeoutMs: 30,
    onFallback: (from) => fallbacks.push(from),
  });
  expect(await decode(only, "hi")).toBe("hi");

  const chain = new FallbackProvider(
    [
      new FakeProvider({ name: "a", failWith: new Error("boom") }),
      new FakeProvider({ name: "say", delayMs: 120 }),
    ],
    { firstByteTimeoutMs: 30, onFallback: (from) => fallbacks.push(from) },
  );
  expect(await decode(chain, "hi")).toBe("hi");
  expect(fallbacks).toEqual(["a"]);
});

test("timeoutFor overrides the first-byte timeout per provider and text", async () => {
  const fallbacks: string[] = [];
  const seen: [string, string][] = [];
  const chain = new FallbackProvider(
    [new FakeProvider({ name: "local", delayMs: 120 }), new FakeProvider({ name: "say" })],
    {
      firstByteTimeoutMs: 30,
      timeoutFor: (provider, text) => {
        seen.push([provider, text]);
        return provider === "local" ? 5_000 : 30;
      },
      onFallback: (from) => fallbacks.push(from),
    },
  );
  expect(await decode(chain, "a long chunk")).toBe("a long chunk");
  expect(fallbacks).toEqual([]);
  expect(seen).toEqual([["local", "a long chunk"]]);
});

test("takes its chunking hint from the first provider", () => {
  const hint = { firstChars: 80, targetChars: 150 };
  const chain = (first: FakeProvider, second: FakeProvider) =>
    new FallbackProvider([first, second], { firstByteTimeoutMs: 1000 });
  expect(chain(new FakeProvider({ chunking: hint }), new FakeProvider()).chunking).toEqual(hint);
  expect(chain(new FakeProvider(), new FakeProvider({ chunking: hint })).chunking).toBeUndefined();
});
