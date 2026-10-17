import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChunks } from "@mouthpiece/core";
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

test("failed stream is not cached", async () => {
  const p = new CachingProvider(new FakeProvider({ failMidStream: true }), {
    dir,
    maxBytes: 1_000_000,
  });
  await expect(text(p, "boom")).rejects.toThrow();
  expect(await readdir(dir).catch(() => [])).toEqual([]);
});

test("abandoned stream is not cached", async () => {
  const p = new CachingProvider(new FakeProvider(), { dir, maxBytes: 1_000_000 });
  const clip = await p.synthesize("partial");
  const it = clip.chunks[Symbol.asyncIterator]();
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
