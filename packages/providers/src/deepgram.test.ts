import { expect, test } from "bun:test";
import { collectChunks } from "@mouthpiece/core";
import { type DeepgramOptions, DeepgramProvider } from "./deepgram.ts";
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
  extra: Partial<DeepgramOptions> = {},
) {
  return new DeepgramProvider({
    apiKey: "k",
    model: "aura-2-thalia-en",
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
    "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=48000",
  );
  expect(req?.headers.get("authorization")).toBe("Token k");
  expect(req?.headers.get("content-type")).toBe("application/json");
  expect(await req?.json()).toEqual({ text: "Hello" });
});

test("an aura- voice option replaces the model", async () => {
  const seen: Request[] = [];
  await provider(audio, seen).synthesize("x", { voice: "aura-2-apollo-en" });
  expect(new URL(seen[0]?.url ?? "").searchParams.get("model")).toBe("aura-2-apollo-en");
});

test("a voice that is not a Deepgram model is ignored", async () => {
  const seen: Request[] = [];
  await provider(audio, seen).synthesize("x", { voice: "Samantha" });
  expect(new URL(seen[0]?.url ?? "").searchParams.get("model")).toBe("aura-2-thalia-en");
});

test("the base URL is injectable", async () => {
  const seen: Request[] = [];
  await provider(audio, seen, { baseUrl: "http://127.0.0.1:9" }).synthesize("x");
  expect(seen[0]?.url).toStartWith("http://127.0.0.1:9/v1/speak?");
});

test("has the documented limits, price and cache key", () => {
  const p = provider(audio);
  expect(p.name).toBe("deepgram");
  expect(p.maxCharsPerRequest).toBe(2000);
  expect(p.pricePerMillionChars).toBe(30);
  expect(p.cacheKey).toBe("aura-2-thalia-en\u0000aura-2-thalia-en");
});

for (const [status, body, message] of [
  [401, { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." }, "Invalid credentials."],
  [413, { err_code: "PAYLOAD_TOO_LARGE", err_msg: "Text exceeds 2000" }, "Text exceeds 2000"],
  [429, { category: "TOO_MANY_REQUESTS", message: "Too many requests" }, "Too many requests"],
] as const) {
  test(`HTTP ${status} rejects with ProviderHttpError and the provider's message`, async () => {
    const error = await provider(() => jsonResponse(body, status))
      .synthesize("x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).provider).toBe("deepgram");
    expect((error as ProviderHttpError).status).toBe(status);
    expect((error as Error).message).toContain(message);
  });
}

test("a malformed error body still rejects with the raw text", async () => {
  const p = provider(() => new Response("{not json", { status: 502 })).synthesize("x");
  await expect(p).rejects.toThrow("{not json");
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

test("listVoices maps aura-2 tts models only", async () => {
  const seen: Request[] = [];
  const p = provider(
    () =>
      jsonResponse({
        stt: [{ canonical_name: "nova-3", name: "nova-3" }],
        tts: [
          { canonical_name: "aura-2-thalia-en", name: "thalia", languages: ["en", "en-US"] },
          { canonical_name: "aura-asteria-en", name: "asteria", languages: ["en"] },
          { canonical_name: "aura-2-celeste-es", name: "celeste", languages: [] },
        ],
      }),
    seen,
  );
  expect(await p.listVoices()).toEqual([
    { id: "aura-2-thalia-en", name: "thalia", language: "en" },
    { id: "aura-2-celeste-es", name: "celeste" },
  ]);
  expect(seen[0]?.url).toBe("https://api.deepgram.com/v1/models");
  expect(seen[0]?.method).toBe("GET");
});

test("listVoices rejects with ProviderHttpError on an HTTP error", async () => {
  const p = provider(() => jsonResponse({ err_msg: "down" }, 503));
  await expect(p.listVoices()).rejects.toBeInstanceOf(ProviderHttpError);
});

const live = LIVE && Boolean(process.env.DEEPGRAM_API_KEY);
test.skipIf(!live)("live: synthesizes real audio", async () => {
  const p = new DeepgramProvider({
    apiKey: process.env.DEEPGRAM_API_KEY ?? "",
    model: "aura-2-thalia-en",
  });
  const bytes = await collectChunks((await p.synthesize("Hello from Mouthpiece.")).chunks);
  expect(bytes.length).toBeGreaterThan(1000);
});
