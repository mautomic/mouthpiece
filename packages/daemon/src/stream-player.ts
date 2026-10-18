import {
  type AudioClip,
  collectChunks,
  type Logger,
  type Player,
  readWavPcm,
  singleChunk,
  type WavPcm,
} from "@mouthpiece/core";

/** The running mouthpiece-player, as StreamPlayer sees it. The protocol is in MouthpiecePlayer.swift. */
export interface PlayerProcess {
  /** Writes one command (JSON, without the newline). */
  send(line: string): void;
  /** The player's events (JSON, without the newline). Read once. */
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface StreamPlayerOptions {
  /** The mouthpiece-player executable. */
  binary: string;
  /** Plays clips that aren't PCM WAV, and everything once the stream player is given up on. */
  fallback: Player;
  log: Logger;
  /** Test seam; spawns `binary` by default. */
  spawn?: (binary: string) => PlayerProcess;
  /** How long the player has to report "ready". Default 3,000 ms. */
  readyTimeoutMs?: number;
  /** How long past a clip's own length its events may take before the player is restarted. Default 3,000 ms. */
  watchdogSlackMs?: number;
  now?: () => number;
}

/** This many exits within EXIT_WINDOW_MS and the player is given up on until the daemon restarts. */
const MAX_EXITS = 3;
const EXIT_WINDOW_MS = 5 * 60_000;

interface Sent {
  /** play() resolves: the clip is about to end ("ending"), or is over. */
  handOff(): void;
  /** The clip is over: played ("done"), flushed, dropped by a reset, or its player exited. */
  finish(): void;
}

/**
 * Plays clips back to back with no break through mouthpiece-player (US-005, US-019). play()
 * resolves when the player reports "ending", with 0.3 s of the clip left, so the speaker sends the
 * next clip while this one finishes.
 *
 * Clips that aren't PCM WAV play through `fallback` once the player's queue has played out, and
 * everything does after MAX_EXITS player exits within EXIT_WINDOW_MS. A clip whose events don't
 * come within its length plus `watchdogSlackMs` restarts the player.
 */
export class StreamPlayer implements Player {
  #proc: PlayerProcess | undefined;
  #ready: Promise<boolean> | undefined;
  #seq = 0;
  readonly #sent = new Map<number, Sent>();
  #drainWaiters: (() => void)[] = [];
  #stopped = false;
  #exits: number[] = [];
  #disabled = false;

  constructor(private readonly opts: StreamPlayerOptions) {}

  /** True while clips go through the player; the speaker then chunks text by sentence. */
  get gapless(): boolean {
    return !this.#stopped && !this.#disabled;
  }

  async play(clip: AudioClip, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const bytes = await collectChunks(clip.chunks);
    if (signal.aborted) return;
    const pcm = clip.format === "wav" ? readWavPcm(bytes) : undefined;
    if (pcm && this.gapless && (await this.#start())) {
      if (signal.aborted) return;
      return this.#playPcm(pcm, signal);
    }
    // The two players must not overlap: let what the stream player has queued play out first.
    await this.#drained(signal);
    if (signal.aborted) return;
    return this.opts.fallback.play({ format: clip.format, chunks: singleChunk(bytes) }, signal);
  }

  /** Kills the player; later clips go to the fallback. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const proc = this.#proc;
    if (!proc) return;
    proc.kill();
    await Promise.race([proc.exited, Bun.sleep(1_000)]);
  }

  #playPcm(pcm: WavPcm, signal: AbortSignal): Promise<void> {
    const id = ++this.#seq;
    const bytesPerFrame = pcm.channels * (pcm.encoding === "f32le" ? 4 : 2);
    const lengthMs = (pcm.data.length / bytesPerFrame / pcm.sampleRate) * 1000;
    return new Promise<void>((resolve) => {
      const onAbort = () => this.#flush();
      const watchdog = setTimeout(
        () => {
          this.opts.log({ level: "warn", msg: "player_unresponsive", id });
          this.#proc?.kill(); // its exit ends every clip it had
        },
        lengthMs + (this.opts.watchdogSlackMs ?? 3_000),
      );
      this.#sent.set(id, {
        handOff: resolve,
        finish: () => {
          clearTimeout(watchdog);
          // The listener stays until the clip is over, so an abort during its tail still flushes it.
          signal.removeEventListener("abort", onAbort);
          this.#sent.delete(id);
          resolve();
          if (this.#sent.size === 0) for (const wake of this.#drainWaiters.splice(0)) wake();
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.#send({
        op: "clip",
        id,
        rate: pcm.sampleRate,
        channels: pcm.channels,
        encoding: pcm.encoding,
      });
      this.#send({ op: "audio", id, data: Buffer.from(pcm.data).toString("base64") });
      this.#send({ op: "end", id });
    });
  }

  /** Stops the player at once and ends every clip it had (stop, skip, pause, interrupt). */
  #flush(): void {
    this.#send({ op: "flush" });
    for (const sent of [...this.#sent.values()]) sent.finish();
  }

  /** Resolves once every clip sent to the player is over, or `signal` aborts. */
  #drained(signal: AbortSignal): Promise<void> {
    if (this.#sent.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#drainWaiters.push(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Starts the player if it isn't running; false when it can't be used for this clip. */
  #start(): Promise<boolean> {
    if (this.#ready) return this.#ready;
    const proc = (this.opts.spawn ?? ((binary) => spawnPlayer([binary])))(this.opts.binary);
    this.#proc = proc;
    let settle: (ok: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.#ready = ready;
    const timeoutMs = this.opts.readyTimeoutMs ?? 3_000;
    const timer = setTimeout(() => {
      this.opts.log({ level: "warn", msg: "player_not_ready", timeoutMs });
      settle(false);
      proc.kill();
    }, timeoutMs);
    const reading = this.#read(proc, () => {
      clearTimeout(timer);
      settle(true);
    });
    void proc.exited.then(async (code) => {
      // Read what it wrote before it died (an "error" saying why) before handling the exit.
      await Promise.race([reading, Bun.sleep(500)]);
      clearTimeout(timer);
      settle(false);
      if (this.#proc === proc) {
        this.#proc = undefined;
        this.#ready = undefined;
      }
      for (const sent of [...this.#sent.values()]) sent.finish();
      if (!this.#stopped) this.#exited(code);
    });
    return ready;
  }

  #exited(code: number): void {
    const now = (this.opts.now ?? Date.now)();
    this.#exits = [...this.#exits.filter((t) => now - t < EXIT_WINDOW_MS), now];
    this.opts.log({ level: "warn", msg: "player_exited", code });
    if (this.#exits.length >= MAX_EXITS && !this.#disabled) {
      this.#disabled = true;
      this.opts.log({
        level: "error",
        msg: "player_disabled",
        hint: "speech plays through afplay until the daemon restarts",
      });
    }
  }

  async #read(proc: PlayerProcess, onReady: () => void): Promise<void> {
    try {
      for await (const line of proc.lines) {
        let event: { event?: unknown; id?: unknown; message?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const sent = typeof event.id === "number" ? this.#sent.get(event.id) : undefined;
        if (event.event === "ready") onReady();
        else if (event.event === "ending") sent?.handOff();
        else if (event.event === "done") sent?.finish();
        else if (event.event === "reset") {
          // The output device changed and the player dropped what it had queued.
          this.opts.log({ level: "warn", msg: "player_reset" });
          for (const s of [...this.#sent.values()]) s.finish();
        } else if (event.event === "error") {
          this.opts.log({ level: "error", msg: "player_error", error: String(event.message) });
        }
      }
    } catch {
      // The pipe broke: the exit handler ends the clips.
    }
  }

  #send(command: Record<string, unknown>): void {
    try {
      this.#proc?.send(JSON.stringify(command));
    } catch {
      // The player is gone: its exit handler ends the clips.
    }
  }
}

/** Runs `command` with stdin and stdout as the protocol pipes; its stderr goes to the daemon's log. */
export function spawnPlayer(command: string[]): PlayerProcess {
  const proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  return {
    send: (line) => {
      proc.stdin.write(`${line}\n`);
      Promise.resolve(proc.stdin.flush()).catch(() => {});
    },
    lines: readLines(proc.stdout),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
}
