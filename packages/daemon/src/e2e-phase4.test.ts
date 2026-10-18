import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { health, pause, resume, setMode, speak, status } from "@mouthpiece/client";
import {
  type AudioClip,
  type Config,
  collectChunks,
  type Player,
  resolveConfig,
} from "@mouthpiece/core";
import { helperBinary, type SpawnFn } from "@mouthpiece/hotkeys";
import { FakeProvider, type KokoroEngine } from "@mouthpiece/providers";
import { type DaemonOptions, type RunningDaemon, startDaemon, VERSION } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";

/**
 * Records each clip's text when it starts and holds it "playing" until release() or an abort, so a
 * test can pause in the middle of an item without depending on timing.
 */
class GatedPlayer implements Player {
  readonly started: string[] = [];
  readonly completed: string[] = [];
  #release: (() => void) | undefined;
  #waiters: { count: number; resolve: () => void }[] = [];

  async play(clip: AudioClip, signal: AbortSignal): Promise<void> {
    const text = new TextDecoder().decode(await collectChunks(clip.chunks));
    if (signal.aborted) return;
    this.started.push(text);
    for (const w of this.#waiters.filter((w) => this.started.length >= w.count)) w.resolve();
    await new Promise<void>((resolve) => {
      this.#release = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (!signal.aborted) this.completed.push(text);
  }

  /** Lets the clip playing finish. */
  release(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  /** Resolves once `count` clips have started. */
  startedCount(count: number): Promise<void> {
    if (this.started.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ count, resolve }));
  }
}

let home: string;
let daemon: RunningDaemon | undefined;
let logs: Record<string, unknown>[];

async function boot(
  config: Config,
  extra: Partial<DaemonOptions> = {},
  prepareHome?: () => Promise<void>,
) {
  home = await mkdtemp(join(tmpdir(), "mp-e2e4-"));
  logs = [];
  await prepareHome?.();
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: join(home, "config.toml") },
    port: 0,
    log: (r) => logs.push(r),
    summarizer: null,
    hotkeys: false,
    watch: false,
    config,
    ...extra,
  });
  return daemon;
}
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await rm(home, { recursive: true, force: true });
});
const o = () => ({ url: daemon?.url, env: { MOUTHPIECE_HOME: home } });
const sayChain = () => resolveConfig({ provider: { chain: ["say"] } });
const plain = { source: "cli", format: "plain", mode: "full" } as const;

const FIRST = "First sentence here.";
const SECOND = "Second sentence here.";
const THIRD = "Third sentence here.";

test("pause, then speak, then resume over HTTP plays the queued item (US-022)", async () => {
  const player = new GatedPlayer();
  const d = await boot(sayChain(), { providers: [new FakeProvider()], player });
  expect(await pause("user", o())).toEqual({ paused: true, pauseReasons: ["user"] });
  await speak({ ...plain, text: "This was queued while paused." }, o());
  expect(player.started).toEqual([]);
  expect(await status(o())).toMatchObject({ paused: true, speaking: false, queueDepth: 1 });

  expect(await resume("user", o())).toEqual({ paused: false, pauseReasons: [] });
  await player.startedCount(1);
  player.release();
  await d.queue.idle();
  expect(player.completed).toEqual(["This was queued while paused."]);
});

test("two reasons both need resuming; an unknown reason is a no-op", async () => {
  const player = new FakePlayer();
  const d = await boot(sayChain(), { providers: [new FakeProvider()], player });
  await pause("mic", o());
  await pause("user", o());
  await speak({ ...plain, text: "This is held by two reasons." }, o());
  expect(await resume("other", o())).toEqual({ paused: true, pauseReasons: ["mic", "user"] });
  expect(await resume("mic", o())).toEqual({ paused: true, pauseReasons: ["user"] });
  expect(player.played).toEqual([]);
  await resume("user", o());
  await d.queue.idle();
  expect(player.played).toEqual(["This is held by two reasons."]);
});

test("pausing mid-item resumes from the interrupted chunk, not the start (US-022)", async () => {
  const player = new GatedPlayer();
  const fake = new FakeProvider({ maxCharsPerRequest: 25 });
  const d = await boot(sayChain(), { providers: [fake], player });
  await speak({ ...plain, text: `${FIRST} ${SECOND} ${THIRD}` }, o());
  await player.startedCount(1);
  player.release();
  await player.startedCount(2);
  expect(player.started).toEqual([FIRST, SECOND]);

  await pause("mic", o());
  expect(await status(o())).toMatchObject({
    speaking: false,
    paused: true,
    pauseReasons: ["mic"],
    current: { source: "cli" },
  });
  await resume("mic", o());
  await player.startedCount(3);
  expect(player.started[2]).toBe(SECOND);
  player.release();
  await player.startedCount(4);
  player.release();
  await d.queue.idle();

  expect(player.started).toEqual([FIRST, SECOND, SECOND, THIRD]);
  expect(player.completed).toEqual([FIRST, SECOND, THIRD]);
  // The chunk before the interrupted one was never synthesized again.
  expect(fake.calls.filter((c) => c === FIRST)).toHaveLength(1);
  // Recorded in history once, with the whole text.
  expect(d.history.size).toBe(1);
  expect(d.history.last()?.spoken).toBe(`${FIRST} ${SECOND} ${THIRD}`);
});

test("status reflects speaking, paused, queueDepth, current and mode (US-018)", async () => {
  const player = new GatedPlayer();
  const d = await boot(sayChain(), { providers: [new FakeProvider()], player });
  expect(await status(o())).toEqual({
    version: VERSION,
    speaking: false,
    paused: false,
    pauseReasons: [],
    mode: "summary",
    queueDepth: 0,
    provider: "fake",
    current: null,
  });
  expect(VERSION).toBe("0.4.0");

  await speak(
    { ...plain, conversationId: "a", label: "web", text: "The first item is playing now." },
    o(),
  );
  await speak({ ...plain, conversationId: "b", text: "The second item waits its turn." }, o());
  await player.startedCount(1);
  expect(await status(o())).toMatchObject({
    speaking: true,
    paused: false,
    queueDepth: 1,
    current: { source: "cli", label: "web" },
  });

  await pause("user", o());
  await setMode({ mode: "full" }, o());
  expect(await status(o())).toMatchObject({
    speaking: false,
    paused: true,
    pauseReasons: ["user"],
    queueDepth: 1,
    mode: "full",
    current: { source: "cli", label: "web" },
  });

  await resume("user", o());
  await player.startedCount(2);
  player.release();
  await player.startedCount(3);
  player.release();
  await d.queue.idle();
  expect(await status(o())).toMatchObject({ speaking: false, queueDepth: 0, current: null });
});

/** A fake helper process whose exit the test controls. */
function fakeHelper() {
  const started: string[][] = [];
  const exits: ((code: number) => void)[] = [];
  let killed = 0;
  const spawn: SpawnFn = (cmd) => {
    started.push(cmd);
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    exits.push(exit);
    return {
      exited,
      kill: () => {
        killed++;
        exit(143);
      },
    };
  };
  return { spawn, started, exit: (code: number) => exits.at(-1)?.(code), killed: () => killed };
}

async function installHelperBinary() {
  const binary = helperBinary(home);
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, "");
}

test("the helper starts with menubar and mic-pause args; its exit clears the mic pause", async () => {
  const helper = fakeHelper();
  const player = new FakePlayer();
  const d = await boot(
    resolveConfig({
      provider: { chain: ["say"] },
      micPause: { ignoreBundleIds: ["us.zoom.xos"], resumeDelayMs: 500 },
    }),
    { providers: [new FakeProvider()], player, hotkeys: true, helperSpawn: helper.spawn },
    installHelperBinary,
  );
  expect(helper.started).toHaveLength(1);
  const cmd = helper.started[0] ?? [];
  expect(cmd[0]).toBe(helperBinary(home));
  expect(cmd).toContain("--menubar");
  expect(cmd).toContain("--bind");
  expect(cmd.join(" ")).toContain(
    "--mic-pause --mic-resume-delay 500 --mic-refresh 200000 --mic-ignore us.zoom.xos",
  );
  expect(cmd.join(" ")).toContain(`--url ${d.url} --token-file ${join(home, "token")}`);

  // The helper reports the mic in use, the user also pauses, then the helper dies.
  await pause("mic", o());
  await pause("user", o());
  await speak({ ...plain, text: "Said after the helper died." }, o());
  helper.exit(1);
  await Bun.sleep(0);
  expect((await status(o())).pauseReasons).toEqual(["user"]);
  expect(logs).toContainEqual(expect.objectContaining({ msg: "hotkeys_restarting", code: 1 }));

  await resume("user", o());
  await d.queue.idle();
  expect(player.played).toEqual(["Said after the helper died."]);

  await d.stop();
  daemon = undefined;
  expect(helper.killed()).toBe(1);
});

test("a helper that exits for good (fatal exit 2) also clears the mic pause", async () => {
  const helper = fakeHelper();
  const player = new FakePlayer();
  const d = await boot(
    resolveConfig({ provider: { chain: ["say"] }, hotkeys: { enabled: false } }),
    { providers: [new FakeProvider()], player, hotkeys: true, helperSpawn: helper.spawn },
    installHelperBinary,
  );
  expect(helper.started[0]).not.toContain("--bind");
  await pause("mic", o());
  await speak({ ...plain, text: "This item is no longer held." }, o());
  helper.exit(2);
  await d.queue.idle();
  expect(player.played).toEqual(["This item is no longer held."]);
  expect(logs).toContainEqual(expect.objectContaining({ msg: "hotkeys_gave_up", code: 2 }));
  expect(await status(o())).toMatchObject({ paused: false, pauseReasons: [] });
});

test("the helper is not started when it isn't built, or when every feature is off", async () => {
  const helper = fakeHelper();
  await boot(sayChain(), {
    providers: [new FakeProvider()],
    player: new FakePlayer(),
    hotkeys: true,
    helperSpawn: helper.spawn,
  });
  expect(helper.started).toEqual([]);
  expect(logs).toContainEqual(expect.objectContaining({ msg: "helper_unavailable" }));
  await daemon?.stop();
  await rm(home, { recursive: true, force: true });

  await boot(
    resolveConfig({
      provider: { chain: ["say"] },
      hotkeys: { enabled: false },
      menubar: { enabled: false },
      micPause: { enabled: false },
    }),
    {
      providers: [new FakeProvider()],
      player: new FakePlayer(),
      hotkeys: true,
      helperSpawn: helper.spawn,
    },
    installHelperBinary,
  );
  expect(helper.started).toEqual([]);
});

/** Marks Kokoro as installed under the temp home (no real package; the loader is injected). */
async function installFakeKokoro() {
  const pkg = join(home, "kokoro", "node_modules", "kokoro-js");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), "{}");
}

test("an installed Kokoro speaks first in the chain and is warmed up at startup (US-019)", async () => {
  const generated: { text: string; voice: string }[] = [];
  let loads = 0;
  const engine: KokoroEngine = {
    async generate(text, { voice }) {
      generated.push({ text, voice });
      return { toWav: () => new TextEncoder().encode(text).buffer as ArrayBuffer };
    },
  };
  const player = new FakePlayer();
  const d = await boot(
    resolveConfig({ provider: { chain: ["kokoro", "say"], kokoro: { voice: "bf_emma" } } }),
    {
      player,
      kokoroLoader: async () => {
        loads++;
        return engine;
      },
    },
    installFakeKokoro,
  );
  expect((await health(o())).provider).toBe("kokoro>say");
  expect((await status(o())).provider).toBe("kokoro");

  await speak({ ...plain, text: "Spoken by the local voice." }, o());
  await d.queue.idle();
  expect(player.played).toEqual(["Spoken by the local voice."]);
  expect(generated).toContainEqual({ text: "Ready.", voice: "bf_emma" });
  expect(generated).toContainEqual({ text: "Spoken by the local voice.", voice: "bf_emma" });
  expect(loads).toBe(1);
  expect(logs).not.toContainEqual(expect.objectContaining({ provider: "kokoro" }));
});

test("a chain listing Kokoro without it installed skips it with one warning", async () => {
  let loads = 0;
  await boot(resolveConfig({ provider: { chain: ["kokoro", "say"] } }), {
    player: new FakePlayer(),
    kokoroLoader: async () => {
      loads++;
      throw new Error("must not load");
    },
  });
  expect((await health(o())).provider).toBe("say");
  expect((await status(o())).provider).toBe("say");
  expect(logs.filter((l) => l.msg === "provider_skipped")).toEqual([
    expect.objectContaining({
      level: "warn",
      provider: "kokoro",
      reason: "not installed; run mouthpiece kokoro install",
    }),
  ]);
  expect(loads).toBe(0);
});

test("stopping the daemon terminates Kokoro's worker (US-019)", async () => {
  let terminated = 0;
  const engine: KokoroEngine = {
    async generate(text) {
      return { toWav: () => new TextEncoder().encode(text).buffer as ArrayBuffer };
    },
  };
  const loader = Object.assign(async () => engine, {
    terminate: () => {
      terminated++;
    },
  });
  const d = await boot(
    resolveConfig({ provider: { chain: ["kokoro", "say"] } }),
    { player: new FakePlayer(), kokoroLoader: loader },
    installFakeKokoro,
  );
  await d.stop();
  daemon = undefined;
  expect(terminated).toBe(1);
});
