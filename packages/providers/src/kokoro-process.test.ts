import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isKokoroInstalled, KokoroProvider } from "./kokoro.ts";
import {
  type ProcessKokoroLoader,
  type ProcessKokoroOptions,
  processKokoroLoader,
} from "./kokoro-process.ts";
import { LIVE } from "./testing.ts";

const FAKE_HOST = fileURLToPath(new URL("./fake-kokoro-host.ts", import.meta.url));

const loaders: ProcessKokoroLoader[] = [];
afterEach(async () => {
  await Promise.all(loaders.splice(0).map((l) => l.terminate()));
});

function fakeLoader(
  home = "/fake/home",
  opts: Omit<ProcessKokoroOptions, "hostScript"> = {},
): ProcessKokoroLoader {
  const loader = processKokoroLoader(home, { hostScript: FAKE_HOST, ...opts });
  loaders.push(loader);
  return loader;
}

/**
 * The error a promise rejects with. Bun's `expect(p).rejects` doesn't run the event loop while it
 * waits, so a rejection that depends on a host message would never arrive.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error) => String(error),
  );
}

/** The fake host's "WAV": `<pid>|<voice>|<text>`. */
async function say(loader: ProcessKokoroLoader, text: string, voice = "af_heart") {
  const engine = await loader();
  const wav = (await engine.generate(text, { voice })).toWav();
  const [pid, v, t] = new TextDecoder().decode(wav).split("|");
  return { pid: Number(pid), voice: v, text: t };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

test("generate runs in a child process and returns its WAV", async () => {
  const loader = fakeLoader();
  const out = await say(loader, "Hello there.", "bf_emma");
  expect(out).toMatchObject({ voice: "bf_emma", text: "Hello there." });
  expect(out.pid).toBeGreaterThan(0);
  expect(out.pid).not.toBe(process.pid);
});

test("the host is started lazily and reused across calls", async () => {
  const loader = fakeLoader();
  const [a, b] = await Promise.all([say(loader, "slow one"), say(loader, "two")]);
  const c = await say(loader, "three");
  expect(new Set([a.pid, b.pid, c.pid]).size).toBe(1);
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

test("an error reply rejects only that request; the host keeps serving", async () => {
  const loader = fakeLoader();
  const engine = await loader();
  expect(await rejection(engine.generate("error", { voice: "af_heart" }))).toContain(
    "generate failed",
  );
  expect((await say(loader, "after")).text).toBe("after");
});

test("a crash rejects every pending request, logs one line, and the next call starts a new host", async () => {
  const logs: Record<string, unknown>[] = [];
  const loader = fakeLoader("/fake/home", { log: (r) => logs.push(r) });
  const engine = await loader();
  const first = await say(loader, "first");
  const crashed = engine.generate("crash", { voice: "af_heart" });
  const queued = engine.generate("queued", { voice: "af_heart" });
  const [crashError, queuedError] = await Promise.all([rejection(crashed), rejection(queued)]);
  expect(crashError).toMatch(/kokoro host exited \(code 1\)/);
  expect(queuedError).toMatch(/kokoro host exited/);
  const next = await say(loader, "next");
  expect(next.text).toBe("next");
  expect(next.pid).not.toBe(first.pid);
  await until(() => logs.length > 0);
  expect(logs).toEqual([
    expect.objectContaining({ level: "warn", msg: "kokoro_host_exited", code: 1 }),
  ]);
});

test("a host that exits is replaced; the log line carries its last stderr line", async () => {
  const logs: Record<string, unknown>[] = [];
  const loader = fakeLoader("/fake/home", { log: (r) => logs.push(r) });
  const engine = await loader();
  const first = await say(loader, "first");
  expect(await rejection(engine.generate("exit", { voice: "af_heart" }))).toContain(
    "kokoro host exited (code 3)",
  );
  const next = await say(loader, "next");
  expect(next.pid).not.toBe(first.pid);
  await until(() => logs.length > 0);
  expect(logs).toEqual([
    {
      level: "warn",
      msg: "kokoro_host_exited",
      code: 3,
      stderr: "fatal: the renderer gave up",
    },
  ]);
});

test("a failed engine load rejects the loader; the next call retries in a new host", async () => {
  const loader = fakeLoader("fail-load");
  expect(await rejection(loader())).toContain("model missing");
  expect(await rejection(loader())).toContain("model missing");
});

test("a load that never finishes times out", async () => {
  const loader = fakeLoader("hang-load", { loadTimeoutMs: 100 });
  expect(await rejection(loader())).toContain("kokoro load timed out after 100ms");
});

test("a hung render restarts the host; the requests behind it are served by the new one", async () => {
  const logs: Record<string, unknown>[] = [];
  const loader = fakeLoader("/fake/home", {
    log: (r) => logs.push(r),
    renderTimeoutMs: (text) => (text === "hang" ? 100 : 5_000),
  });
  const engine = await loader();
  const first = await say(loader, "first");
  const hung = rejection(engine.generate("hang", { voice: "af_heart" }));
  const behind = say(loader, "behind");
  expect(await hung).toContain("kokoro render timed out after 100ms");
  const served = await behind;
  expect(served.text).toBe("behind");
  expect(served.pid).not.toBe(first.pid);
  await until(() => !isAlive(first.pid));
  expect(logs).toEqual([{ level: "warn", msg: "kokoro_render_timeout", ms: 100, chars: 4 }]);
});

test("terminate rejects pending requests and kills the host; a later call starts a new one", async () => {
  const logs: Record<string, unknown>[] = [];
  const loader = fakeLoader("/fake/home", { log: (r) => logs.push(r) });
  const engine = await loader();
  const first = await say(loader, "first");
  const hungError = rejection(engine.generate("hang", { voice: "af_heart" }));
  const queuedError = rejection(engine.generate("queued", { voice: "af_heart" }));
  await loader.terminate();
  expect(await hungError).toContain("terminated");
  expect(await queuedError).toContain("terminated");
  expect(isAlive(first.pid)).toBe(false);
  const next = await say(loader, "next");
  expect(next.pid).not.toBe(first.pid);
  expect(logs).toEqual([]); // a kill we asked for is not an abnormal exit
});

test("terminate kills a host in the middle of a synchronous render, promptly", async () => {
  const loader = fakeLoader();
  const engine = await loader();
  const { pid } = await say(loader, "first");
  const blocked = rejection(engine.generate("block", { voice: "af_heart" }));
  await Bun.sleep(50); // the host is now busy-waiting and can't read messages
  const started = performance.now();
  await loader.terminate();
  expect(performance.now() - started).toBeLessThan(500);
  expect(await blocked).toContain("terminated");
  expect(isAlive(pid)).toBe(false);
});

test("terminate escalates to SIGKILL when the host ignores SIGTERM", async () => {
  const loader = fakeLoader("ignore-term");
  const { pid } = await say(loader, "first");
  const started = performance.now();
  await loader.terminate();
  const took = performance.now() - started;
  expect(took).toBeGreaterThan(900);
  expect(took).toBeLessThan(1_600);
  expect(isAlive(pid)).toBe(false);
});

test("terminate before any call is a no-op", async () => {
  await fakeLoader().terminate();
});

test("the host's stdout and stderr never reach the daemon's", async () => {
  const loaderUrl = new URL("./kokoro-process.ts", import.meta.url).href;
  const script = `
    const { processKokoroLoader } = await import(${JSON.stringify(loaderUrl)});
    const loader = processKokoroLoader("/fake/home", { hostScript: ${JSON.stringify(FAKE_HOST)} });
    const engine = await loader();
    await engine.generate("noisy", { voice: "af_heart" });
    await engine.generate("noisy", { voice: "af_heart" }).catch(() => {});
    await engine.generate("crash", { voice: "af_heart" }).catch(() => {});
    await loader.terminate();
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
});

test("KokoroProvider over the process loader returns the host's WAV", async () => {
  const provider = new KokoroProvider({ voice: "am_adam", load: fakeLoader() });
  const clip = await provider.synthesize("Through the provider.");
  const bytes: Uint8Array[] = [];
  for await (const c of clip.chunks) bytes.push(c);
  expect(new TextDecoder().decode(bytes[0])).toEndWith("|am_adam|Through the provider.");
});

test("the real host reports a load failure when kokoro-js isn't installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "mp-kokoro-host-"));
  try {
    const loader = processKokoroLoader(home);
    loaders.push(loader);
    const provider = new KokoroProvider({ voice: "af_heart", load: loader });
    expect(await rejection(provider.synthesize("Hello."))).toMatch(/kokoro-js|transformers/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Live: the real engine, through the host. Uses the Kokoro install at $MOUTHPIECE_KOKORO_LIVE_DIR
// (linked as <tmp home>/kokoro) or $MOUTHPIECE_HOME.
const liveDir = process.env.MOUTHPIECE_KOKORO_LIVE_DIR;
const liveHomeOk = liveDir !== undefined || isKokoroInstalled(process.env.MOUTHPIECE_HOME ?? "");
const LONG =
  "All one hundred and eighty two tests pass and lint is clean. The pause feature now holds the interrupted item and resumes it from the chunk that was playing.";

async function withLiveHome(fn: (home: string) => Promise<void>): Promise<void> {
  let home = process.env.MOUTHPIECE_HOME ?? "";
  let tmp: string | undefined;
  if (liveDir) {
    tmp = await mkdtemp(join(tmpdir(), "mp-kokoro-live-"));
    await symlink(liveDir, join(tmp, "kokoro"));
    home = tmp;
  }
  try {
    await fn(home);
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

// An in-process generate stalled the main loop for its whole duration (1.4 s for 71 chars).
test.skipIf(!LIVE || !liveHomeOk)(
  "live: a real generate in the host keeps the main loop ticking (max gap < 100 ms)",
  () =>
    withLiveHome(async (home) => {
      const loader = processKokoroLoader(home, { allowRemoteModels: false });
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
      const clip = await provider.synthesize(LONG);
      const generateMs = performance.now() - started;
      clearInterval(interval);
      maxGap = Math.max(maxGap, performance.now() - last);
      console.log(
        JSON.stringify({ generateMs: Math.round(generateMs), maxGapMs: Math.round(maxGap) }),
      );
      expect(clip.format).toBe("wav");
      expect(generateMs).toBeGreaterThan(500); // a real render, long enough to measure
      expect(maxGap).toBeLessThan(100);
    }),
  60_000,
);

// Terminating a Bun Worker mid-load or mid-render crashed the whole process (exit 134). Run in a
// separate process so a regression can't take the test runner down with it.
test.skipIf(!LIVE || !liveHomeOk)(
  "live: terminating the host mid-load and mid-render leaves the process healthy",
  () =>
    withLiveHome(async (home) => {
      const loaderUrl = new URL("./kokoro-process.ts", import.meta.url).href;
      const script = `
        const { processKokoroLoader } = await import(${JSON.stringify(loaderUrl)});
        const home = process.env.KOKORO_TEST_HOME;
        const text = ${JSON.stringify(LONG)};
        const loader = processKokoroLoader(home);
        const loading = loader().catch((e) => String(e)); // mid-load
        await Bun.sleep(100);
        await loader.terminate();
        console.log("load:", await loading);
        const engine = await loader();
        await engine.generate("Ready.", { voice: "af_heart" });
        const rendering = engine.generate(text, { voice: "af_heart" }).then(() => "done", String);
        await Bun.sleep(800); // mid-render
        await loader.terminate();
        console.log("render:", await rendering);
        const again = await (await loader()).generate("Still here.", { voice: "af_heart" });
        console.log("again:", again.toWav().byteLength > 1000);
        await loader.terminate();
      `;
      const proc = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, KOKORO_TEST_HOME: home },
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(out).toBe(
        "load: Error: kokoro host terminated\nrender: Error: kokoro host terminated\nagain: true\n",
      );
    }),
  60_000,
);
