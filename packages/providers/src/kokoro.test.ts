import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultKokoroLoader,
  isKokoroInstalled,
  KOKORO_VOICES,
  type KokoroEngine,
  type KokoroLoader,
  KokoroProvider,
  kokoroHome,
} from "./kokoro.ts";
import { LIVE } from "./testing.ts";

const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]); // "RIFF…"

function fakeEngine(opts: { failWith?: Error } = {}) {
  const calls: { text: string; voice: string }[] = [];
  const engine: KokoroEngine = {
    async generate(text, { voice }) {
      calls.push({ text, voice });
      if (opts.failWith) throw opts.failWith;
      return { toWav: () => WAV.slice().buffer };
    },
  };
  return { engine, calls };
}

function harness(opts: { load?: KokoroLoader; voice?: string; failWith?: Error } = {}) {
  const { engine, calls } = fakeEngine({ failWith: opts.failWith });
  let loads = 0;
  const logs: Record<string, unknown>[] = [];
  const provider = new KokoroProvider({
    voice: opts.voice ?? "af_heart",
    load:
      opts.load ??
      (async () => {
        loads++;
        return engine;
      }),
    log: (r) => logs.push(r),
  });
  return { provider, calls, logs, loads: () => loads };
}

/** How `promise` settles, or "still pending" if it hasn't within a few event-loop turns. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  const pending = Bun.sleep(20).then(() => "still pending");
  return Promise.race([
    promise.then(
      () => "resolved",
      (error) => `${(error as Error)?.name}: ${String(error)}`,
    ),
    pending,
  ]);
}

async function bytesOf(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const c of chunks) out.push(c);
  return out;
}

test("identity: name, cap, price, cache key", () => {
  const { provider } = harness({ voice: "bf_emma" });
  expect(provider.name).toBe("kokoro");
  expect(provider.maxCharsPerRequest).toBe(400);
  expect(provider.pricePerMillionChars).toBe(0);
  expect(provider.cacheKey).toBe("bf_emma\0q8");
});

test("the engine loads lazily, once, even for concurrent calls", async () => {
  const h = harness();
  expect(h.loads()).toBe(0);
  await Promise.all([h.provider.synthesize("One."), h.provider.synthesize("Two.")]);
  await h.provider.synthesize("Three.");
  expect(h.loads()).toBe(1);
  expect(h.calls.map((c) => c.text)).toEqual(["One.", "Two.", "Three."]);
});

test("a failed load is retried on the next call and logged once", async () => {
  const { engine } = fakeEngine();
  let attempts = 0;
  const h = harness({
    load: async () => {
      attempts++;
      if (attempts <= 2) throw new Error("model missing");
      return engine;
    },
  });
  await expect(h.provider.synthesize("a")).rejects.toThrow("model missing");
  await expect(h.provider.synthesize("b")).rejects.toThrow("model missing");
  const clip = await h.provider.synthesize("c");
  expect(clip.format).toBe("wav");
  expect(attempts).toBe(3);
  const failures = h.logs.filter((r) => r.msg === "kokoro_load_failed");
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ level: "warn", error: expect.stringContaining("model") });
});

test("Kokoro voice ids are used; foreign or unknown ids fall back to the configured voice", async () => {
  const h = harness({ voice: "am_michael" });
  await h.provider.synthesize("a", { voice: "bf_emma" });
  await h.provider.synthesize("b", { voice: "Ashley" }); // an Inworld voice from the chain
  await h.provider.synthesize("c", { voice: "21m00Tcm4TlvDq8ikWAM" }); // an ElevenLabs id
  await h.provider.synthesize("d", { voice: "af_nobody" }); // right prefix, not a Kokoro voice
  await h.provider.synthesize("e");
  expect(h.calls.map((c) => c.voice)).toEqual([
    "bf_emma",
    "am_michael",
    "am_michael",
    "am_michael",
    "am_michael",
  ]);
});

test("an unknown configured voice warns once and uses af_heart", async () => {
  const h = harness({ voice: "af_hart" }); // a typo
  expect(h.logs).toEqual([
    { level: "warn", msg: "kokoro_voice_invalid", voice: "af_hart", using: "af_heart" },
  ]);
  await h.provider.synthesize("a");
  await h.provider.synthesize("b");
  expect(h.calls.map((c) => c.voice)).toEqual(["af_heart", "af_heart"]);
  expect(h.provider.cacheKey).toBe("af_heart\0q8");
  expect(h.logs).toHaveLength(1);

  expect(harness({ voice: "bm_george" }).logs).toEqual([]);
});

test("an abort before generate rejects without generating", async () => {
  const h = harness();
  const ac = new AbortController();
  ac.abort();
  await expect(h.provider.synthesize("a", { signal: ac.signal })).rejects.toThrow();
  expect(h.calls).toEqual([]);
});

test("an abort during generate rejects after it returns", async () => {
  const ac = new AbortController();
  const provider = new KokoroProvider({
    voice: "af_heart",
    load: async () => ({
      async generate() {
        ac.abort();
        return { toWav: () => WAV.slice().buffer };
      },
    }),
  });
  await expect(provider.synthesize("a", { signal: ac.signal })).rejects.toThrow();
});

test("an abort during a render that never ends rejects at once and tells the engine", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const provider = new KokoroProvider({
    voice: "af_heart",
    load: async () => ({
      generate(_text, { signal }) {
        signals.push(signal);
        return new Promise(() => {}); // a render that outlives the item
      },
    }),
  });
  const ac = new AbortController();
  const pending = provider.synthesize("a long render", { signal: ac.signal });
  await Bun.sleep(0);
  expect(signals).toHaveLength(1);
  ac.abort();
  expect(signals[0]?.aborted).toBe(true);
  // Rejects without waiting for the engine, which would otherwise hold the queue.
  expect(await outcome(pending)).toContain("AbortError");
});

test("an abort while the engine is still loading rejects at once", async () => {
  const provider = new KokoroProvider({
    voice: "af_heart",
    load: () => new Promise(() => {}),
  });
  const ac = new AbortController();
  const pending = provider.synthesize("a", { signal: ac.signal });
  await Bun.sleep(0);
  ac.abort();
  expect(await outcome(pending)).toContain("AbortError");
});

test("output is the engine's WAV in a single chunk", async () => {
  const h = harness();
  const clip = await h.provider.synthesize("Hello.");
  expect(clip.format).toBe("wav");
  expect(await bytesOf(clip.chunks)).toEqual([WAV]);
});

test("a generate failure rejects (so the chain falls back)", async () => {
  const h = harness({ failWith: new Error("onnx exploded") });
  await expect(h.provider.synthesize("a")).rejects.toThrow("onnx exploded");
});

test("listVoices returns the 28 English voices", async () => {
  const h = harness();
  const voices = await h.provider.listVoices();
  expect(voices).toHaveLength(28);
  expect(KOKORO_VOICES).toHaveLength(28);
  expect(voices.every((v) => /^[ab][fm]_[a-z]+$/.test(v.id))).toBe(true);
  expect(voices.find((v) => v.id === "af_heart")).toEqual({
    id: "af_heart",
    name: "Heart",
    language: "en-US",
  });
  expect(voices.find((v) => v.id === "bm_lewis")?.language).toBe("en-GB");
  expect(h.loads()).toBe(0); // static list, no model load
});

test("warmUp loads the engine and generates once", async () => {
  const h = harness();
  await h.provider.warmUp();
  expect(h.loads()).toBe(1);
  expect(h.calls).toEqual([{ text: "Ready.", voice: "af_heart" }]);
});

test("warmUp swallows load and generate errors", async () => {
  const failingLoad = harness({
    load: async () => {
      throw new Error("not installed");
    },
  });
  await failingLoad.provider.warmUp();
  expect(failingLoad.logs.filter((r) => r.msg === "kokoro_load_failed")).toHaveLength(1);

  const failingGenerate = harness({ failWith: new Error("boom") });
  await failingGenerate.provider.warmUp();
  expect(failingGenerate.logs).toContainEqual(
    expect.objectContaining({ level: "warn", msg: "kokoro_warmup_failed" }),
  );
});

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-kokoro-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("kokoroHome is <home>/kokoro", () => {
  expect(kokoroHome("/x/.mouthpiece")).toBe("/x/.mouthpiece/kokoro");
});

test("isKokoroInstalled checks for kokoro-js under <home>/kokoro/node_modules", async () => {
  expect(isKokoroInstalled(home)).toBe(false);
  const pkg = join(home, "kokoro", "node_modules", "kokoro-js");
  await mkdir(pkg, { recursive: true });
  expect(isKokoroInstalled(home)).toBe(false);
  await writeFile(join(pkg, "package.json"), "{}");
  expect(isKokoroInstalled(home)).toBe(true);
});

test("defaultKokoroLoader rejects when kokoro-js is not installed", async () => {
  await expect(defaultKokoroLoader(home)()).rejects.toThrow();
});

// Needs a real `mouthpiece kokoro install` (in MOUTHPIECE_HOME or ~/.mouthpiece). Never installs.
const liveHome = process.env.MOUTHPIECE_HOME || join(homedir(), ".mouthpiece");
test.skipIf(!LIVE || !isKokoroInstalled(liveHome))(
  "live: Kokoro generates a WAV",
  async () => {
    const provider = new KokoroProvider({
      voice: "af_heart",
      load: defaultKokoroLoader(liveHome),
    });
    const clip = await provider.synthesize("Hello.");
    const bytes = (await bytesOf(clip.chunks))[0];
    expect(clip.format).toBe("wav");
    expect(bytes?.byteLength).toBeGreaterThan(10_000);
  },
  30_000,
);
