import { expect, test } from "bun:test";
import { collectChunks } from "@mouthpiece/core";
import { FakeProvider } from "./fake.ts";
import { FallbackProvider } from "./fallback.ts";
import {
  INWORLD_STREAM_URL,
  InworldError,
  type InworldOptions,
  InworldProvider,
} from "./inworld.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
      controller.close();
    },
  });
}

/** A body that sends `parts` and then stays open without sending anything else. */
function stalledStreamOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
    },
  });
}

function provider(response: Response, seen: Request[] = [], extra: Partial<InworldOptions> = {}) {
  return new InworldProvider({
    ...extra,
    apiKey: "QUJD",
    model: "inworld-tts-2-flash",
    voice: "Ashley",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return response;
    }) as unknown as typeof fetch,
  });
}

test("sends the documented request and decodes NDJSON split across chunks", async () => {
  const seen: Request[] = [];
  const line1 = JSON.stringify({ result: { audioContent: b64("ab") } });
  const line2 = JSON.stringify({ result: { audioContent: b64("cd") } });
  const body = streamOf(line1.slice(0, 10), `${line1.slice(10)}\n${line2}`, "\n");
  const clip = await provider(new Response(body), seen).synthesize("Hello", { voice: "Dennis" });
  expect(clip.format).toBe("mp3");
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("abcd");

  const req = seen[0];
  expect(req?.url).toBe(INWORLD_STREAM_URL);
  expect(req?.headers.get("authorization")).toBe("Basic QUJD");
  expect(await req?.json()).toEqual({
    text: "Hello",
    voiceId: "Dennis",
    modelId: "inworld-tts-2-flash",
    audioConfig: { audioEncoding: "MP3", sampleRateHertz: 48000 },
  });
});

test("HTTP error rejects with status", async () => {
  const p = provider(new Response('{"code":3,"message":"bad"}', { status: 400 })).synthesize("x");
  await expect(p).rejects.toBeInstanceOf(InworldError);
  await expect(p).rejects.toThrow("400");
});

test("mid-stream error line throws from the chunk iterator", async () => {
  const body = streamOf(
    `${JSON.stringify({ result: { audioContent: b64("ok") } })}\n`,
    `${JSON.stringify({ error: { code: 3, message: "too long" } })}\n`,
  );
  const clip = await provider(new Response(body)).synthesize("x");
  await expect(collectChunks(clip.chunks)).rejects.toThrow("too long");
});

test("ignores lines without audio (usage/timestamps)", async () => {
  const body = streamOf(
    `${JSON.stringify({ result: { audioContent: b64("a") } })}\n${JSON.stringify({ result: { timestampInfo: {} } })}\n`,
  );
  const clip = await provider(new Response(body)).synthesize("x");
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("a");
});

test("a 200 whose body never sends audio falls back on the first-byte timeout (FR-8)", async () => {
  const fallbacks: string[] = [];
  const chain = new FallbackProvider(
    [provider(new Response(stalledStreamOf())), new FakeProvider({ name: "say" })],
    { firstByteTimeoutMs: 100, onFallback: (from) => fallbacks.push(from) },
  );
  const started = performance.now();
  const clip = await chain.synthesize("hi");
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("hi");
  expect(fallbacks).toEqual(["inworld"]);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("an error line before any audio rejects synthesize so the chain can fall back", async () => {
  const body = streamOf(`${JSON.stringify({ error: { code: 8, message: "quota" } })}\n`);
  await expect(provider(new Response(body)).synthesize("x")).rejects.toThrow("quota");
});

test("a body that ends without audio rejects synthesize", async () => {
  const body = streamOf(`${JSON.stringify({ result: { timestampInfo: {} } })}\n`);
  await expect(provider(new Response(body)).synthesize("x")).rejects.toBeInstanceOf(InworldError);
});

test("a stream that stalls after the first audio fails after the idle timeout", async () => {
  const body = stalledStreamOf(`${JSON.stringify({ result: { audioContent: b64("a") } })}\n`);
  const clip = await provider(new Response(body), [], { streamIdleTimeoutMs: 50 }).synthesize("x");
  const started = performance.now();
  await expect(collectChunks(clip.chunks)).rejects.toThrow("stalled");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("aborting the signal stops reading the stream", async () => {
  const body = stalledStreamOf(`${JSON.stringify({ result: { audioContent: b64("a") } })}\n`);
  const controller = new AbortController();
  const clip = await provider(new Response(body)).synthesize("x", { signal: controller.signal });
  const collected = collectChunks(clip.chunks);
  controller.abort();
  await expect(collected).rejects.toBeDefined();
});

const live = process.env.MOUTHPIECE_LIVE_TESTS === "1" && Boolean(process.env.INWORLD_API_KEY);
test.skipIf(!live)("live: synthesizes real audio", async () => {
  const p = new InworldProvider({
    apiKey: process.env.INWORLD_API_KEY ?? "",
    model: "inworld-tts-2-flash",
    voice: "Ashley",
  });
  expect(
    (await collectChunks((await p.synthesize("Hello from Mouthpiece.")).chunks)).length,
  ).toBeGreaterThan(1000);
});
