import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKokoroInstalled, KokoroProvider } from "./kokoro.ts";
import { type WorkerKokoroLoader, workerKokoroLoader } from "./kokoro-worker-loader.ts";
import { LIVE } from "./testing.ts";

const FAKE_WORKER = new URL("./fake-kokoro-worker.ts", import.meta.url);

const loaders: WorkerKokoroLoader[] = [];
afterEach(async () => {
  await Promise.all(loaders.splice(0).map((l) => l.terminate()));
});

function fakeLoader(home = "/fake/home"): WorkerKokoroLoader {
  const loader = workerKokoroLoader(home, { workerUrl: FAKE_WORKER });
  loaders.push(loader);
  return loader;
}

/**
 * The error a promise rejects with. Bun's `expect(p).rejects` doesn't run the event loop while it
 * waits, so a rejection that depends on a worker message would never arrive.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error) => String(error),
  );
}

/** The fake worker's "WAV": `<threadId>|<voice>|<text>`. */
async function say(loader: WorkerKokoroLoader, text: string, voice = "af_heart") {
  const engine = await loader();
  const wav = (await engine.generate(text, { voice })).toWav();
  const [thread, v, t] = new TextDecoder().decode(wav).split("|");
  return { thread: Number(thread), voice: v, text: t };
}

test("generate runs in the worker and returns its WAV", async () => {
  const loader = fakeLoader();
  const out = await say(loader, "Hello there.", "bf_emma");
  expect(out).toMatchObject({ voice: "bf_emma", text: "Hello there." });
  expect(out.thread).toBeGreaterThan(0); // not the main thread (0)
});

test("the worker is created lazily and reused across calls", async () => {
  const loader = fakeLoader();
  const [a, b] = await Promise.all([say(loader, "slow one"), say(loader, "two")]);
  const c = await say(loader, "three");
  expect(new Set([a.thread, b.thread, c.thread]).size).toBe(1);
  expect([a.text, b.text, c.text]).toEqual(["slow one", "two", "three"]);
});

test("concurrent requests are matched to their own replies", async () => {
  const loader = fakeLoader();
  const engine = await loader();
  const texts = ["slow a", "b", "slow c", "d"];
  const out = await Promise.all(
    texts.map(async (t) =>
      new TextDecoder().decode((await engine.generate(t, { voice: "af_sky" })).toWav()),
    ),
  );
  expect(out.map((s) => s.split("|")[2])).toEqual(texts);
});

test("an error reply rejects only that request; the worker keeps serving", async () => {
  const loader = fakeLoader();
  const engine = await loader();
  expect(await rejection(engine.generate("error", { voice: "af_heart" }))).toContain(
    "generate failed",
  );
  const before = await say(loader, "after");
  expect(before.text).toBe("after");
});

test("a crash rejects every pending request, and the next call starts a new worker", async () => {
  const loader = fakeLoader();
  const engine = await loader();
  const first = await say(loader, "first");
  const hung = engine.generate("hang", { voice: "af_heart" });
  const crashed = engine.generate("crash", { voice: "af_heart" });
  const [crashError, hungError] = await Promise.all([rejection(crashed), rejection(hung)]);
  expect(crashError).toMatch(/kokoro worker crashed/);
  expect(hungError).toMatch(/kokoro worker crashed/);
  const next = await say(loader, "next");
  expect(next.text).toBe("next");
  expect(next.thread).not.toBe(first.thread);
});

test("a worker that exits rejects its pending requests and is replaced", async () => {
  const loader = fakeLoader();
  const engine = await loader();
  const first = await say(loader, "first");
  expect(await rejection(engine.generate("exit", { voice: "af_heart" }))).toMatch(/kokoro worker/);
  const next = await say(loader, "next");
  expect(next.thread).not.toBe(first.thread);
});

test("a failed engine load rejects the loader; the next call retries in a new worker", async () => {
  const loader = fakeLoader("fail-load");
  expect(await rejection(loader())).toContain("model missing");
  expect(await rejection(loader())).toContain("model missing");
});

test("terminate rejects pending requests; a later call starts a new worker", async () => {
  const loader = fakeLoader();
  const engine = await loader();
  const first = await say(loader, "first");
  const hung = engine.generate("hang", { voice: "af_heart" });
  const hungError = rejection(hung);
  await loader.terminate();
  expect(await hungError).toContain("terminated");
  const next = await say(loader, "next");
  expect(next.thread).not.toBe(first.thread);
});

test("terminate before any call is a no-op", async () => {
  await fakeLoader().terminate();
});

test("KokoroProvider over the worker loader returns the worker's WAV", async () => {
  const provider = new KokoroProvider({ voice: "am_adam", load: fakeLoader() });
  const clip = await provider.synthesize("Through the provider.");
  const bytes: Uint8Array[] = [];
  for await (const c of clip.chunks) bytes.push(c);
  expect(new TextDecoder().decode(bytes[0])).toEndWith("|am_adam|Through the provider.");
});

test("a late reply after an abort is ignored (the provider rejects)", async () => {
  const provider = new KokoroProvider({ voice: "af_heart", load: fakeLoader() });
  await provider.warmUp();
  const ac = new AbortController();
  const pending = provider.synthesize("slow reply", { signal: ac.signal });
  setTimeout(() => ac.abort(), 10); // while the worker is generating
  expect(await rejection(pending)).toContain("Abort");
  const clip = await provider.synthesize("still fine");
  expect(clip.format).toBe("wav");
});

test("the real worker entry reports a load failure when kokoro-js isn't installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "mp-kokoro-worker-"));
  try {
    const loader = workerKokoroLoader(home);
    loaders.push(loader);
    const provider = new KokoroProvider({ voice: "af_heart", load: loader });
    expect(await rejection(provider.synthesize("Hello."))).toMatch(/kokoro-js|transformers/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Live: the real engine through the worker must not block the main event loop (finding: an
// in-process generate stalled it for its whole duration, 1.4 s for 71 chars). Uses the Kokoro
// install at $MOUTHPIECE_KOKORO_LIVE_DIR (linked as <tmp home>/kokoro) or $MOUTHPIECE_HOME.
const liveDir = process.env.MOUTHPIECE_KOKORO_LIVE_DIR;
const liveHomeOk = liveDir !== undefined || isKokoroInstalled(process.env.MOUTHPIECE_HOME ?? "");
test.skipIf(!LIVE || !liveHomeOk)(
  "live: a real generate in the worker keeps the main loop ticking (max gap < 100 ms)",
  async () => {
    let home = process.env.MOUTHPIECE_HOME ?? "";
    let tmp: string | undefined;
    if (liveDir) {
      tmp = await mkdtemp(join(tmpdir(), "mp-kokoro-live-"));
      await symlink(liveDir, join(tmp, "kokoro"));
      home = tmp;
    }
    try {
      const loader = workerKokoroLoader(home, { allowRemoteModels: false });
      loaders.push(loader);
      const provider = new KokoroProvider({ voice: "af_heart", load: loader });
      await provider.warmUp();
      let maxGap = 0;
      let last = performance.now();
      const interval = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 10);
      const started = performance.now();
      const clip = await provider.synthesize(
        "All one hundred and eighty two tests pass and lint is clean. The pause feature now holds the interrupted item and resumes it from the chunk that was playing.",
      );
      const generateMs = performance.now() - started;
      clearInterval(interval);
      maxGap = Math.max(maxGap, performance.now() - last);
      console.log(
        JSON.stringify({ generateMs: Math.round(generateMs), maxGapMs: Math.round(maxGap) }),
      );
      expect(clip.format).toBe("wav");
      expect(generateMs).toBeGreaterThan(500); // a real render, long enough to measure
      expect(maxGap).toBeLessThan(100);
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true });
    }
  },
  60_000,
);
