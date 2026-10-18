import { expect, test } from "bun:test";
import { collectChunks } from "@mouthpiece/core";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ProviderHttpError,
  readErrorMessage,
  streamBody,
  streamingClip,
} from "./http.ts";
import { brokenStreamOf, stalledStreamOf, streamOf } from "./testing.ts";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const errorOf = (body: unknown) => readErrorMessage(new Response(JSON.stringify(body)));

test("ProviderHttpError carries provider and status", () => {
  const e = new ProviderHttpError("openai", 429, "slow down");
  expect(e).toBeInstanceOf(Error);
  expect(e.provider).toBe("openai");
  expect(e.status).toBe(429);
  expect(e.message).toBe("openai HTTP 429: slow down");
});

test("readErrorMessage understands every provider error shape", async () => {
  expect(await errorOf({ detail: { status: "invalid_api_key", message: "bad key" } })).toBe(
    "bad key",
  );
  expect(await errorOf({ detail: [{ loc: ["body"], msg: "field required" }] })).toBe(
    "field required",
  );
  expect(await errorOf({ err_code: "INVALID_AUTH", err_msg: "Invalid credentials." })).toBe(
    "Invalid credentials.",
  );
  expect(await errorOf({ category: "INVALID_AUTH", message: "no token" })).toBe("no token");
  expect(await errorOf({ error: { message: "Incorrect API key", type: "x" } })).toBe(
    "Incorrect API key",
  );
});

test("readErrorMessage falls back to the raw text", async () => {
  expect(await readErrorMessage(new Response("Bad Gateway"))).toBe("Bad Gateway");
  expect(await readErrorMessage(new Response('{"unexpected":true}'))).toBe('{"unexpected":true}');
  expect(await readErrorMessage(new Response("null"))).toBe("null");
  expect(await readErrorMessage(new Response("x".repeat(1000)))).toHaveLength(300);
  expect(await readErrorMessage(new Response(""))).toBe("no body");
});

test("streamBody yields the chunks in order", async () => {
  const chunks: string[] = [];
  for await (const c of streamBody(streamOf("a", "b", "c"), { idleTimeoutMs: 1000, provider: "p" }))
    chunks.push(decode(c));
  expect(chunks).toEqual(["a", "b", "c"]);
});

test("streamBody throws 'stream stalled' when nothing arrives for idleTimeoutMs", async () => {
  const started = performance.now();
  const iter = streamBody(stalledStreamOf(), { idleTimeoutMs: 50, provider: "deepgram" });
  const error = await collectChunks(iter).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderHttpError);
  expect((error as ProviderHttpError).status).toBe(0);
  expect((error as ProviderHttpError).provider).toBe("deepgram");
  expect((error as Error).message).toContain("stream stalled");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("streamBody stops when the signal aborts", async () => {
  const controller = new AbortController();
  const iter = streamBody(stalledStreamOf("a"), {
    idleTimeoutMs: 5000,
    provider: "p",
    signal: controller.signal,
  });
  const collected = collectChunks(iter);
  setTimeout(() => controller.abort(new Error("stopped")), 10);
  await expect(collected).rejects.toThrow("stopped");
});

test("the default idle timeout is 10 s", () => {
  expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(10_000);
});

test("streamingClip resolves with the first chunk and streams the rest", async () => {
  const clip = await streamingClip(new Response(streamOf("ab", "cd")), { provider: "p" });
  expect(clip.format).toBe("mp3");
  expect(decode(await collectChunks(clip.chunks))).toBe("abcd");
});

test("streamingClip rejects with the provider's message on an HTTP error", async () => {
  const res = new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 });
  const error = await streamingClip(res, { provider: "openai" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderHttpError);
  expect((error as ProviderHttpError).status).toBe(401);
  expect((error as Error).message).toContain("nope");
});

test("streamingClip rejects when the body ends without audio", async () => {
  await expect(streamingClip(new Response(streamOf()), { provider: "p" })).rejects.toBeInstanceOf(
    ProviderHttpError,
  );
});

test("streamingClip rejects when the body stalls before the first byte", async () => {
  const p = streamingClip(new Response(stalledStreamOf()), { provider: "p", idleTimeoutMs: 50 });
  await expect(p).rejects.toThrow("stream stalled");
});

test("streamingClip: a mid-stream failure throws from the chunk iterator", async () => {
  const clip = await streamingClip(new Response(brokenStreamOf("ab")), { provider: "p" });
  await expect(collectChunks(clip.chunks)).rejects.toThrow("connection reset");
});
