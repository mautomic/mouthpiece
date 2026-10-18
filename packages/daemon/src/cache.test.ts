import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChunks, type TtsProvider } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { CachingProvider } from "./cache.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const text = async (p: CachingProvider, t: string, voice?: string) => {
  const clip = await p.synthesize(t, { voice });
  return {
    cached: clip.cached ?? false,
    body: new TextDecoder().decode(await collectChunks(clip.chunks)),
  };
};

test("second identical request is served from cache", async () => {
  const inner = new FakeProvider();
  const p = new CachingProvider(inner, { dir, maxBytes: 1_000_000 });
  expect(await text(p, "hello")).toEqual({ cached: false, body: "hello" });
  expect(await text(p, "hello")).toEqual({ cached: true, body: "hello" });
  expect(inner.calls).toEqual(["hello"]);
  expect(await text(p, "hello", "other-voice")).toEqual({ cached: false, body: "hello" });
});

test("a provider configured with a different voice or model misses the cache", async () => {
  const ashley = new CachingProvider(new FakeProvider({ cacheKey: "Ashley" }), {
    dir,
    maxBytes: 1_000_000,
  });
  expect(await text(ashley, "hello")).toEqual({ cached: false, body: "hello" });
  expect(await text(ashley, "hello")).toEqual({ cached: true, body: "hello" });
  const dennis = new FakeProvider({ cacheKey: "Dennis" });
  const p = new CachingProvider(dennis, { dir, maxBytes: 1_000_000 });
  expect(await text(p, "hello")).toEqual({ cached: false, body: "hello" });
  expect(dennis.calls).toEqual(["hello"]);
});

test("failed stream is not cached", async () => {
  const p = new CachingProvider(new FakeProvider({ failMidStream: true }), {
    dir,
    maxBytes: 1_000_000,
  });
  await expect(text(p, "boom")).rejects.toThrow();
  expect(await readdir(dir).catch(() => [])).toEqual([]);
});

test("a stream abandoned partway through is not cached", async () => {
  const multiChunk: TtsProvider = {
    name: "multi",
    maxCharsPerRequest: 1000,
    pricePerMillionChars: 1,
    synthesize: async (t) => ({
      format: "mp3",
      chunks: (async function* () {
        for (const part of t.split(" ")) yield new TextEncoder().encode(part);
      })(),
    }),
  };
  const p = new CachingProvider(multiChunk, { dir, maxBytes: 1_000_000 });
  const clip = await p.synthesize("one two three");
  const it = clip.chunks[Symbol.asyncIterator]();
  expect((await it.next()).done).toBe(false);
  await it.return?.();
  expect(await readdir(dir).catch(() => [])).toEqual([]);
});

test("evicts oldest files beyond maxBytes", async () => {
  const p = new CachingProvider(new FakeProvider(), { dir, maxBytes: 10 });
  await text(p, "aaaaaa");
  await Bun.sleep(5);
  await text(p, "bbbbbb");
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  expect((await stat(join(dir, files[0] ?? ""))).size).toBe(6);
  expect(await text(p, "bbbbbb")).toEqual({ cached: true, body: "bbbbbb" });
});

test("maxBytes 0 disables caching", async () => {
  const inner = new FakeProvider();
  const p = new CachingProvider(inner, { dir, maxBytes: 0 });
  await text(p, "x");
  await text(p, "x");
  expect(inner.calls).toEqual(["x", "x"]);
});

test("a cache write failure does not fail a stream that played fully", async () => {
  const blocker = join(dir, "not-a-dir");
  await Bun.write(blocker, "x");
  const p = new CachingProvider(new FakeProvider(), {
    dir: join(blocker, "cache"),
    maxBytes: 1_000,
  });
  expect(await text(p, "still plays")).toEqual({ cached: false, body: "still plays" });
});
