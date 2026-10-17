import { expect, test } from "bun:test";
import { collectChunks } from "@mouthpiece/core";
import { type ElevenLabsOptions, ElevenLabsProvider } from "./elevenlabs.ts";
import { FakeProvider } from "./fake.ts";
import { FallbackProvider } from "./fallback.ts";
import { ProviderHttpError } from "./http.ts";
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
  extra: Partial<ElevenLabsOptions> = {},
) {
  return new ElevenLabsProvider({
    apiKey: "k",
    model: "eleven_flash_v2_5",
    voice: "JBFqnCBsd6RMkjVDRZzb",
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
  expect(req?.url).toBe(
    "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128",
  );
  expect(req?.headers.get("xi-api-key")).toBe("k");
  expect(req?.headers.get("content-type")).toBe("application/json");
  expect(await req?.json()).toEqual({ text: "Hello", model_id: "eleven_flash_v2_5" });
});

test("a voice option overrides the configured voice", async () => {
  const seen: Request[] = [];
  await provider(audio, seen).synthesize("x", { voice: "V2" });
  expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v1/text-to-speech/V2/stream");
});

test("the base URL is injectable", async () => {
  const seen: Request[] = [];
  await provider(audio, seen, { baseUrl: "http://127.0.0.1:9" }).synthesize("x");
  expect(seen[0]?.url).toStartWith("http://127.0.0.1:9/v1/text-to-speech/");
});

test("has the documented limits, price and cache key", () => {
  const p = provider(audio);
  expect(p.name).toBe("elevenlabs");
  expect(p.maxCharsPerRequest).toBe(2000);
  expect(p.pricePerMillionChars).toBe(40);
  expect(p.cacheKey).toBe("JBFqnCBsd6RMkjVDRZzb\u0000eleven_flash_v2_5");
});

for (const [status, body, message] of [
  [401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }, "Invalid API key"],
  [413, { detail: { message: "text too long" } }, "text too long"],
  [422, { detail: [{ loc: ["body", "text"], msg: "field required" }] }, "field required"],
  [429, { detail: { status: "too_many_concurrent_requests", message: "busy" } }, "busy"],
] as const) {
  test(`HTTP ${status} rejects with ProviderHttpError and the provider's message`, async () => {
    const error = await provider(() => jsonResponse(body, status))
      .synthesize("x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).provider).toBe("elevenlabs");
    expect((error as ProviderHttpError).status).toBe(status);
    expect((error as Error).message).toContain(message);
  });
}

test("a malformed error body still rejects with the raw text", async () => {
  const p = provider(() => new Response("<html>oops</html>", { status: 500 })).synthesize("x");
  await expect(p).rejects.toThrow("<html>oops</html>");
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

test("a 200 that never sends audio falls back on the first-byte timeout (FR-8)", async () => {
  const fallbacks: string[] = [];
  const chain = new FallbackProvider(
    [provider(() => new Response(stalledStreamOf())), new FakeProvider({ name: "say" })],
    { firstByteTimeoutMs: 100, onFallback: (from) => fallbacks.push(from) },
  );
  const clip = await chain.synthesize("hi");
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("hi");
  expect(fallbacks).toEqual(["elevenlabs"]);
});

test("listVoices maps voices[] and sends the key", async () => {
  const seen: Request[] = [];
  const p = provider(
    () =>
      jsonResponse({
        voices: [
          {
            voice_id: "JBFqnCBsd6RMkjVDRZzb",
            name: "George",
            verified_languages: [{ language: "en", model_id: "eleven_flash_v2_5" }],
          },
          { voice_id: "abc", name: "Nameless" },
        ],
        has_more: false,
      }),
    seen,
  );
  expect(await p.listVoices()).toEqual([
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", language: "en" },
    { id: "abc", name: "Nameless" },
  ]);
  expect(seen[0]?.url).toBe("https://api.elevenlabs.io/v2/voices?page_size=100");
  expect(seen[0]?.headers.get("xi-api-key")).toBe("k");
});

test("listVoices rejects with ProviderHttpError on an HTTP error", async () => {
  const p = provider(() => jsonResponse({ detail: { message: "Invalid API key" } }, 401));
  await expect(p.listVoices()).rejects.toBeInstanceOf(ProviderHttpError);
});

test("usageStatus maps the subscription", async () => {
  const seen: Request[] = [];
  const p = provider(
    () =>
      jsonResponse({
        character_count: 1234,
        character_limit: 100000,
        next_character_count_reset_unix: 1_790_000_000,
        tier: "starter",
      }),
    seen,
  );
  expect(await p.usageStatus()).toEqual({
    usedChars: 1234,
    limitChars: 100000,
    resetsAt: new Date(1_790_000_000 * 1000).toISOString(),
  });
  expect(seen[0]?.url).toBe("https://api.elevenlabs.io/v1/user/subscription");
  expect(seen[0]?.headers.get("xi-api-key")).toBe("k");
});

test("usageStatus returns undefined on 401 without throwing", async () => {
  const p = provider(() => jsonResponse({ detail: { message: "Invalid API key" } }, 401));
  expect(await p.usageStatus()).toBeUndefined();
});

test("usageStatus returns undefined on a malformed body", async () => {
  expect(await provider(() => jsonResponse({ tier: "free" })).usageStatus()).toBeUndefined();
});

const live = LIVE && Boolean(process.env.ELEVENLABS_API_KEY);
test.skipIf(!live)("live: synthesizes real audio", async () => {
  const p = new ElevenLabsProvider({
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    model: "eleven_flash_v2_5",
    voice: "JBFqnCBsd6RMkjVDRZzb",
  });
  const bytes = await collectChunks((await p.synthesize("Hello from Mouthpiece.")).chunks);
  expect(bytes.length).toBeGreaterThan(1000);
});
