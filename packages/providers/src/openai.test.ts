import { expect, test } from "bun:test";
import { collectChunks } from "@mouthpiece/core";
import { ProviderHttpError } from "./http.ts";
import { type OpenAIOptions, OpenAIProvider } from "./openai.ts";
import {
  brokenStreamOf,
  jsonResponse,
  LIVE,
  recordingFetch,
  stalledStreamOf,
  streamOf,
} from "./testing.ts";

function provider(
  respond: (req: Request) => Response,
  seen: Request[] = [],
  extra: Partial<OpenAIOptions> = {},
) {
  return new OpenAIProvider({
    apiKey: "k",
    model: "tts-1",
    voice: "alloy",
    fetch: recordingFetch(respond, seen),
    ...extra,
  });
}

const audio = () => new Response(streamOf("ID3", "mp3"));

test("sends the documented request and streams raw MP3", async () => {
  const seen: Request[] = [];
  const clip = await provider(audio, seen).synthesize("Hello");
  expect(clip.format).toBe("mp3");
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("ID3mp3");
  const req = seen[0];
  expect(req?.method).toBe("POST");
  expect(req?.url).toBe("https://api.openai.com/v1/audio/speech");
  expect(req?.headers.get("authorization")).toBe("Bearer k");
  expect(req?.headers.get("content-type")).toBe("application/json");
  expect(await req?.json()).toEqual({
    model: "tts-1",
    input: "Hello",
    voice: "alloy",
    response_format: "mp3",
  });
});

test("a voice option overrides the configured voice", async () => {
  const seen: Request[] = [];
  await provider(audio, seen).synthesize("x", { voice: "V2" });
  expect(await seen[0]?.json()).toMatchObject({ voice: "V2" });
});

test("instructions are sent only for gpt-4o-mini-tts models", async () => {
  const withMini: Request[] = [];
  await provider(audio, withMini, {
    model: "gpt-4o-mini-tts",
    instructions: "Speak calmly.",
  }).synthesize("x");
  expect(await withMini[0]?.json()).toMatchObject({ instructions: "Speak calmly." });

  const withTts1: Request[] = [];
  await provider(audio, withTts1, { instructions: "Speak calmly." }).synthesize("x");
  expect(await withTts1[0]?.json()).not.toHaveProperty("instructions");

  const unconfigured: Request[] = [];
  await provider(audio, unconfigured, { model: "gpt-4o-mini-tts" }).synthesize("x");
  expect(await unconfigured[0]?.json()).not.toHaveProperty("instructions");
});

test("the base URL is injectable", async () => {
  const seen: Request[] = [];
  await provider(audio, seen, { baseUrl: "http://127.0.0.1:9" }).synthesize("x");
  expect(seen[0]?.url).toBe("http://127.0.0.1:9/v1/audio/speech");
});

test("has the documented limits, price and cache key", () => {
  const p = provider(audio);
  expect(p.name).toBe("openai");
  expect(p.maxCharsPerRequest).toBe(2000);
  expect(p.pricePerMillionChars).toBe(15);
  expect(p.cacheKey).toBe("alloy\u0000tts-1");
  expect(provider(audio, [], { model: "tts-1-hd" }).pricePerMillionChars).toBe(30);
  expect(provider(audio, [], { model: "gpt-4o-mini-tts" }).pricePerMillionChars).toBe(15);
});

test("instructions that change the audio change the cache key", () => {
  const key = (instructions?: string) =>
    provider(audio, [], { model: "gpt-4o-mini-tts", instructions }).cacheKey;
  expect(key()).toBe("alloy\u0000gpt-4o-mini-tts");
  expect(key("Speak calmly.")).not.toBe(key());
  expect(key("Speak calmly.")).not.toBe(key("Whisper."));
});

for (const [status, message] of [
  [401, "Incorrect API key provided"],
  [413, "Request too large"],
  [429, "Rate limit reached"],
] as const) {
  test(`HTTP ${status} rejects with ProviderHttpError and the provider's message`, async () => {
    const body = { error: { message, type: "invalid_request_error", code: null } };
    const error = await provider(() => jsonResponse(body, status))
      .synthesize("x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).provider).toBe("openai");
    expect((error as ProviderHttpError).status).toBe(status);
    expect((error as Error).message).toContain(message);
  });
}

test("a malformed error body still rejects with the raw text", async () => {
  const p = provider(() => new Response("upstream connect error", { status: 503 })).synthesize("x");
  await expect(p).rejects.toThrow("upstream connect error");
});

test("a body that errors partway makes the chunk iterator reject", async () => {
  const clip = await provider(() => new Response(brokenStreamOf("ID3"))).synthesize("x");
  await expect(collectChunks(clip.chunks)).rejects.toThrow("connection reset");
});

test("a stream that stalls after the first audio fails after the idle timeout", async () => {
  const p = provider(() => new Response(stalledStreamOf("ID3")), [], { streamIdleTimeoutMs: 50 });
  const clip = await p.synthesize("x");
  const started = performance.now();
  await expect(collectChunks(clip.chunks)).rejects.toThrow("stream stalled");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("listVoices returns the fixed list for the model without a request", async () => {
  const seen: Request[] = [];
  const mini = await provider(audio, seen, { model: "gpt-4o-mini-tts" }).listVoices();
  expect(mini).toHaveLength(13);
  expect(mini.map((v) => v.id)).toContain("marin");
  expect(mini.map((v) => v.id)).toContain("cedar");
  const tts1 = await provider(audio, seen).listVoices();
  expect(tts1).toHaveLength(11);
  expect(tts1.map((v) => v.id)).not.toContain("marin");
  expect(tts1[0]).toEqual({ id: "alloy", name: "alloy" });
  expect(seen).toHaveLength(0);
});

const live = LIVE && Boolean(process.env.OPENAI_API_KEY);
test.skipIf(!live)("live: synthesizes real audio", async () => {
  const p = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: "tts-1",
    voice: "alloy",
  });
  const bytes = await collectChunks((await p.synthesize("Hello from Mouthpiece.")).chunks);
  expect(bytes.length).toBeGreaterThan(1000);
});
