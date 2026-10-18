import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AudioClip, collectChunks, type Player, singleChunk } from "@mouthpiece/core";
import { FakePlayerProcess } from "./fake-player-process.ts";
import {
  createPlayer,
  StreamPlayer,
  type StreamPlayerOptions,
  spawnPlayer,
} from "./stream-player.ts";

const FAKE_HOST = fileURLToPath(new URL("./fake-player-host.ts", import.meta.url));

/** A mono 32-bit float WAV of `ms` milliseconds of silence at 24 kHz. */
function wavClip(ms = 100): AudioClip {
  const frames = Math.round(24 * ms);
  const data = frames * 4;
  const view = new DataView(new ArrayBuffer(44 + data));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  return { format: "wav", chunks: singleChunk(new Uint8Array(view.buffer)) };
}

const mp3Clip = (): AudioClip => ({
  format: "mp3",
  chunks: singleChunk(new Uint8Array([0xff, 0xfb, 0x90, 0])),
});

/** The fallback: records each clip's format, and plays instantly. */
class RecordingPlayer implements Player {
  readonly played: string[] = [];
  async play(clip: AudioClip): Promise<void> {
    await collectChunks(clip.chunks);
    this.played.push(clip.format);
  }
}

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(1);
  }
}

function harness(
  opts: { ready?: boolean } & Partial<Omit<StreamPlayerOptions, "fallback" | "log" | "spawn">> = {},
) {
  const procs: FakePlayerProcess[] = [];
  const fallback = new RecordingPlayer();
  const logs: Record<string, unknown>[] = [];
  const player = new StreamPlayer({
    binary: "/fake/mouthpiece-player",
    fallback,
    log: (r) => logs.push(r),
    spawn: () => {
      const proc = new FakePlayerProcess({ ready: opts.ready });
      procs.push(proc);
      return proc;
    },
    readyTimeoutMs: opts.readyTimeoutMs ?? 1_000,
    watchdogSlackMs: opts.watchdogSlackMs ?? 1_000,
    now: opts.now,
  });
  const proc = () => {
    const last = procs.at(-1);
    if (!last) throw new Error("no player process yet");
    return last;
  };
  const sentEnd = (id: number) => procs.at(-1)?.ops.includes(`end ${id}`) ?? false;
  return { player, procs, proc, fallback, logs, sentEnd };
}

test("a PCM WAV clip is sent as clip, audio and end, and play resolves on ending, before done", async () => {
  const h = harness();
  let resolved = false;
  const playing = h.player.play(wavClip(100), new AbortController().signal).then(() => {
    resolved = true;
  });
  await until(() => h.sentEnd(1));
  expect(h.proc().ops).toEqual(["clip 1", "audio 1", "end 1"]);
  expect(h.proc().commands[0]).toEqual({
    op: "clip",
    id: 1,
    rate: 24_000,
    channels: 1,
    encoding: "f32le",
  });
  expect(Buffer.from(String(h.proc().commands[1]?.data), "base64").length).toBe(2_400 * 4);
  await Bun.sleep(5);
  expect(resolved).toBe(false);
  h.proc().emit({ event: "ending", id: 1 });
  await playing;
  expect(h.fallback.played).toEqual([]);
  expect(h.player.gapless).toBe(true);
});

test("the next clip is sent while the one before is still playing", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const first = h.player.play(wavClip(), signal);
  await until(() => h.sentEnd(1));
  h.proc().emit({ event: "ending", id: 1 });
  await first;
  const second = h.player.play(wavClip(), signal);
  await until(() => h.sentEnd(2)); // before clip 1 is done: no break between them
  h.proc().emit({ event: "done", id: 1 });
  h.proc().emit({ event: "ending", id: 2 });
  await second;
  expect(h.procs).toHaveLength(1);
});

test("an abort flushes the player and play resolves at once", async () => {
  const h = harness();
  const controller = new AbortController();
  const playing = h.player.play(wavClip(), controller.signal);
  await until(() => h.sentEnd(1));
  controller.abort();
  await playing;
  expect(h.proc().ops.at(-1)).toBe("flush");
});

test("an abort during the handoff flushes both clips", async () => {
  const h = harness();
  const controller = new AbortController();
  const first = h.player.play(wavClip(), controller.signal);
  await until(() => h.sentEnd(1));
  h.proc().emit({ event: "ending", id: 1 });
  await first;
  const second = h.player.play(wavClip(), controller.signal);
  await until(() => h.sentEnd(2));
  controller.abort();
  await second;
  expect(h.proc().ops.filter((op) => op === "flush")).toHaveLength(1);
  // A late "done" for a flushed clip changes nothing.
  h.proc().emit({ event: "done", id: 1 });
  await Bun.sleep(5);
});

test("an already aborted signal sends nothing", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await h.player.play(wavClip(), controller.signal);
  expect(h.procs).toHaveLength(0);
});

test("unknown events and events for unknown clips are ignored", async () => {
  const h = harness();
  const playing = h.player.play(wavClip(), new AbortController().signal);
  await until(() => h.sentEnd(1));
  h.proc().emit({ event: "ending", id: 99 });
  h.proc().emit({ event: "mystery" });
  h.proc().emit({ event: "ending", id: 1 });
  await playing;
});

test("spawnPlayer speaks the line protocol over real pipes, including a 10 s clip", async () => {
  const fallback = new RecordingPlayer();
  const player = new StreamPlayer({
    binary: FAKE_HOST,
    fallback,
    log: () => {},
    spawn: () => spawnPlayer([process.execPath, FAKE_HOST]),
  });
  try {
    await player.play(wavClip(10_000), new AbortController().signal); // ~1.3 MB of base64 on one line
    await player.play(wavClip(), new AbortController().signal);
    expect(fallback.played).toEqual([]);
  } finally {
    await player.stop();
  }
});

test("a clip that isn't PCM WAV waits for the player's queue to play out, then goes to the fallback", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const first = h.player.play(wavClip(), signal);
  await until(() => h.sentEnd(1));
  h.proc().emit({ event: "ending", id: 1 });
  await first;
  const second = h.player.play(mp3Clip(), signal);
  await Bun.sleep(5);
  expect(h.fallback.played).toEqual([]); // clip 1's tail is still playing
  h.proc().emit({ event: "done", id: 1 });
  await second;
  expect(h.fallback.played).toEqual(["mp3"]);
});

test("a player that doesn't report ready in time is killed, and the clip goes to the fallback", async () => {
  const h = harness({ ready: false, readyTimeoutMs: 20 });
  await h.player.play(wavClip(), new AbortController().signal);
  expect(h.fallback.played).toEqual(["wav"]);
  expect(h.proc().killed).toBe(true);
  expect(h.logs).toContainEqual(
    expect.objectContaining({ level: "warn", msg: "player_not_ready" }),
  );
});

test("a player that exits mid-clip ends that clip, and the next clip starts a new player", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const first = h.player.play(wavClip(), signal);
  await until(() => h.sentEnd(1));
  h.proc().exit(1);
  await first;
  expect(h.logs).toContainEqual(
    expect.objectContaining({ level: "warn", msg: "player_exited", code: 1 }),
  );
  const second = h.player.play(wavClip(), signal);
  await until(() => h.procs.length === 2 && h.sentEnd(2));
  h.proc().emit({ event: "ending", id: 2 });
  await second;
  expect(h.player.gapless).toBe(true);
});

test("3 exits within 5 minutes turn the player off: the fallback plays everything", async () => {
  const clock = { t: 0 };
  const h = harness({ now: () => clock.t });
  const signal = new AbortController().signal;
  for (let i = 1; i <= 3; i++) {
    clock.t += 60_000;
    const playing = h.player.play(wavClip(), signal);
    await until(() => h.procs.length === i && h.sentEnd(i));
    h.proc().exit(1);
    await playing;
  }
  expect(h.player.gapless).toBe(false);
  expect(h.logs.filter((l) => l.msg === "player_disabled")).toEqual([
    expect.objectContaining({ level: "error", msg: "player_disabled" }),
  ]);
  await h.player.play(wavClip(), signal);
  expect(h.procs).toHaveLength(3);
  expect(h.fallback.played).toEqual(["wav"]);
});

test("exits spread over more than 5 minutes don't turn the player off", async () => {
  const clock = { t: 0 };
  const h = harness({ now: () => clock.t });
  const signal = new AbortController().signal;
  for (let i = 1; i <= 3; i++) {
    clock.t += 3 * 60_000;
    const playing = h.player.play(wavClip(), signal);
    await until(() => h.procs.length === i && h.sentEnd(i));
    h.proc().exit(1);
    await playing;
  }
  expect(h.player.gapless).toBe(true);
});

test("a reset from the player ends the clips it dropped", async () => {
  const h = harness();
  const playing = h.player.play(wavClip(), new AbortController().signal);
  await until(() => h.sentEnd(1));
  h.proc().emit({ event: "reset" });
  await playing;
  expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", msg: "player_reset" }));
});

test("an error event is logged", async () => {
  const h = harness();
  const playing = h.player.play(wavClip(), new AbortController().signal);
  await until(() => h.sentEnd(1));
  h.proc().emit({ event: "error", message: "could not start audio" });
  h.proc().exit(1);
  await playing;
  expect(h.logs).toContainEqual(
    expect.objectContaining({
      level: "error",
      msg: "player_error",
      error: "could not start audio",
    }),
  );
});

test("a clip whose events never come is given up on after its length plus the slack, and the player restarted", async () => {
  const h = harness({ watchdogSlackMs: 20 });
  await h.player.play(wavClip(10), new AbortController().signal);
  expect(h.proc().killed).toBe(true);
  expect(h.logs).toContainEqual(
    expect.objectContaining({ level: "warn", msg: "player_unresponsive", id: 1 }),
  );
});

test("stop() kills the player, and later clips go to the fallback", async () => {
  const h = harness();
  const playing = h.player.play(wavClip(), new AbortController().signal);
  await until(() => h.sentEnd(1));
  await h.player.stop();
  await playing;
  expect(h.proc().killed).toBe(true);
  expect(h.logs.some((l) => l.msg === "player_exited")).toBe(false);
  await h.player.play(wavClip(), new AbortController().signal);
  expect(h.fallback.played).toEqual(["wav"]);
});

test("createPlayer: the stream player when it's built, afplay when it isn't or it's turned off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mp-create-player-"));
  try {
    const binary = join(dir, "mouthpiece-player");
    const fallback = new RecordingPlayer();
    const logs: Record<string, unknown>[] = [];
    const log = (r: Record<string, unknown>) => logs.push(r);
    const missing = createPlayer({ backend: "auto", binary, fallback, log });
    expect(missing.name).toBe("afplay");
    expect(missing.player).toBe(fallback);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "player_afplay" }));
    await writeFile(binary, "");
    const built = createPlayer({ backend: "auto", binary, fallback, log });
    expect(built.name).toBe("stream");
    expect(built.player).toBeInstanceOf(StreamPlayer);
    const off = createPlayer({ backend: "afplay", binary, fallback, log });
    expect(off.name).toBe("afplay");
    expect(off.player).toBe(fallback);
    await built.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a player that can't be started counts as an exit, and the clip plays through the fallback", async () => {
  const fallback = new RecordingPlayer();
  const logs: Record<string, unknown>[] = [];
  const player = new StreamPlayer({
    binary: "/fake/mouthpiece-player",
    fallback,
    log: (r) => logs.push(r),
    spawn: () => {
      throw new Error("EACCES: permission denied, posix_spawn");
    },
  });
  for (let i = 0; i < 3; i++) await player.play(wavClip(), new AbortController().signal);
  expect(fallback.played).toEqual(["wav", "wav", "wav"]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      level: "warn",
      msg: "player_start_failed",
      error: expect.stringContaining("EACCES"),
    }),
  );
  expect(player.gapless).toBe(false); // 3 failed starts, like 3 exits, turn it off
});
