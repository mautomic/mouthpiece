import { fileURLToPath } from "node:url";
import type { Logger } from "@mouthpiece/core";
import type { Subprocess } from "bun";
import { KOKORO_MS_PER_CHAR, type KokoroEngine, type KokoroLoader } from "./kokoro.ts";

/** Passed to the host as its only argument, as JSON. */
export interface KokoroHostData {
  home: string;
  allowRemoteModels: boolean;
}

/** Daemon → host: render `text`. The daemon sends one at a time and waits for its reply. */
export interface KokoroHostRequest {
  id: number;
  text: string;
  voice: string;
}

/** Host → daemon. `ready` / `loadError` once, after the engine load; then one `wav` or `error` per request. */
export type KokoroHostReply =
  | { ready: true }
  | { loadError: string }
  | { id: number; wav: Uint8Array }
  | { id: number; error: string };

export interface ProcessKokoroOptions {
  /** Default false: only the model `mouthpiece kokoro install` downloaded is used. */
  allowRemoteModels?: boolean;
  /** Test seam: the host script (default `./kokoro-host.ts`), speaking the same protocol. */
  hostScript?: string;
  /** Receives one line when the host exits on its own or a render hangs. */
  log?: Logger;
  /** How long one render may take before the host is presumed hung. Default kokoroRenderTimeoutMs. */
  renderTimeoutMs?: (text: string) => number;
  /** How long the engine load may take. Default KOKORO_LOAD_TIMEOUT_MS. */
  loadTimeoutMs?: number;
}

/** A loader whose engine runs in a child process. */
export interface ProcessKokoroLoader extends KokoroLoader {
  /**
   * Kills the host (SIGTERM, then SIGKILL after a second), rejecting its pending requests, and
   * resolves once it has exited (or after TERMINATE_WAIT_MS). Safe at any time, mid-render too.
   */
  terminate(): Promise<void>;
}

/** The model loads in about 0.5 s on an M4 Pro; a minute means something is wrong. */
export const KOKORO_LOAD_TIMEOUT_MS = 60_000;

/**
 * The render time after which the host is presumed hung and restarted: well past the fallback
 * chain's first-byte timeout (which only abandons the render), so only a stuck renderer trips it.
 */
export function kokoroRenderTimeoutMs(text: string): number {
  return 10_000 + text.length * KOKORO_MS_PER_CHAR;
}

/** A render's expected time per character (about 20 ms on an M4 Pro: 3.2 s for 157 characters). */
const EXPECTED_MS_PER_CHAR = 20;

/**
 * An abandoned render (its caller aborted) expected to need longer than this is not waited for once
 * another request is waiting: the host is killed and restarted instead, which costs about 1 s
 * (0.4 s to load the model, plus a slower first render). Shorter ones finish and are discarded.
 */
export const ABANDONED_RENDER_WAIT_MS = 2_000;

const KILL_GRACE_MS = 1_000;
const TERMINATE_WAIT_MS = 1_500;
/** How much of the host's stderr is kept for the exit log line. */
const STDERR_TAIL_CHARS = 4_096;

interface Job {
  id: number;
  text: string;
  voice: string;
  resolve(wav: Uint8Array): void;
  reject(error: unknown): void;
}

interface Render {
  job: Job;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** The caller aborted: the job has already rejected, and the reply will be discarded. */
  abandoned: boolean;
}

/** One host process: its load state, the requests waiting for it, and the one it is rendering. */
interface Host {
  proc: Subprocess;
  ready: Promise<void>;
  settleReady(error?: Error): void;
  loaded: boolean;
  loadTimer: ReturnType<typeof setTimeout>;
  queue: Job[];
  current: Render | undefined;
  exited: Promise<void>;
  retired: boolean;
}

/**
 * Kokoro in a child process (`bun kokoro-host.ts`). Its `generate()` is synchronous ONNX work that
 * blocks its thread for the whole render, so it can't run on the daemon's event loop. A Bun Worker
 * isn't enough: terminating one while onnxruntime is loading or rendering crashes the whole process
 * (exit 134, NAPI fatal error). A child process can be killed at any time.
 *
 * The host starts on first use and renders one request at a time; the rest wait here, in order.
 * If it crashes, exits or fails to load, every pending request rejects and the next call starts a
 * fresh host. A render that exceeds its render timeout restarts the host, and the requests waiting
 * behind it move to the new one.
 *
 * An aborted request rejects at once. If it hasn't been sent, it is dropped. If it is rendering,
 * the host can't be interrupted (the render blocks its thread), so the render is abandoned: it
 * finishes and its reply is discarded, unless another request is waiting and the abandoned render
 * is expected to need more than ABANDONED_RENDER_WAIT_MS, in which case the host is restarted.
 *
 * The host's stdout is discarded and its stderr kept only for the one log line an unexpected exit
 * produces.
 */
export function processKokoroLoader(
  home: string,
  opts: ProcessKokoroOptions = {},
): ProcessKokoroLoader {
  const script = opts.hostScript ?? fileURLToPath(new URL("./kokoro-host.ts", import.meta.url));
  const data: KokoroHostData = { home, allowRemoteModels: opts.allowRemoteModels ?? false };
  const renderTimeoutMs = opts.renderTimeoutMs ?? kokoroRenderTimeoutMs;
  const loadTimeoutMs = opts.loadTimeoutMs ?? KOKORO_LOAD_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  let host: Host | undefined;
  let seq = 0;

  /** SIGTERM, then SIGKILL if it is still around after KILL_GRACE_MS. */
  const kill = (h: Host) => {
    h.proc.kill("SIGTERM");
    const timer = setTimeout(() => h.proc.kill("SIGKILL"), KILL_GRACE_MS);
    timer.unref?.();
    void h.exited.then(() => clearTimeout(timer));
  };

  /**
   * Retires `h` (once): kills it and rejects its load, its render and its queue, or returns the
   * queue (requests not yet sent) when `keepQueue` is set.
   */
  const retire = (h: Host, error: Error, keepQueue = false): Job[] => {
    if (h.retired) return [];
    h.retired = true;
    if (host === h) host = undefined;
    clearTimeout(h.loadTimer);
    h.settleReady(error);
    if (h.current) {
      clearTimeout(h.current.timer);
      h.current.job.reject(error);
      h.current = undefined;
    }
    const queued = h.queue.splice(0);
    if (!keepQueue) for (const job of queued) job.reject(error);
    kill(h);
    return keepQueue ? queued : [];
  };

  /** Replaces `h`: its render rejects with `error`; the requests waiting behind it move on. */
  const restart = (h: Host, error: Error) => {
    const queued = retire(h, error, true);
    if (queued.length === 0) return;
    const next = start();
    next.queue.push(...queued);
    pump(next);
  };

  /** Sends the next request once the host has loaded and finished the previous one. */
  const pump = (h: Host) => {
    if (h.retired || !h.loaded || h.current) return;
    const job = h.queue.shift();
    if (!job) return;
    const ms = renderTimeoutMs(job.text);
    const timer = setTimeout(() => {
      log({ level: "warn", msg: "kokoro_render_timeout", ms, chars: job.text.length });
      restart(h, new Error(`kokoro render timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    h.current = { job, startedAt: performance.now(), timer, abandoned: false };
    const request: KokoroHostRequest = { id: job.id, text: job.text, voice: job.voice };
    try {
      h.proc.send(request);
    } catch (error) {
      retire(h, new Error(`kokoro host unreachable: ${describe(error)}`));
    }
  };

  /** Restarts `h` rather than make a waiting request sit behind a long abandoned render. */
  const skipAbandoned = (h: Host) => {
    const render = h.current;
    if (!render?.abandoned || h.queue.length === 0) return;
    const left =
      render.startedAt + render.job.text.length * EXPECTED_MS_PER_CHAR - performance.now();
    if (left > ABANDONED_RENDER_WAIT_MS) restart(h, new Error("kokoro render abandoned"));
  };

  /** The caller of `job` aborted: drop it if it hasn't been sent, else abandon its render. */
  const abandon = (job: Job, reason: unknown) => {
    job.reject(reason);
    const h = host;
    if (!h) return;
    const index = h.queue.indexOf(job);
    if (index >= 0) h.queue.splice(index, 1);
    else if (h.current?.job === job) {
      h.current.abandoned = true;
      skipAbandoned(h);
    }
  };

  const onMessage = (h: Host, m: KokoroHostReply) => {
    if (h.retired) return;
    if ("ready" in m) {
      clearTimeout(h.loadTimer);
      h.loaded = true;
      h.settleReady();
      return pump(h);
    }
    if ("loadError" in m) {
      retire(h, new Error(m.loadError));
      return;
    }
    const current = h.current;
    if (current?.job.id !== m.id) return;
    clearTimeout(current.timer);
    h.current = undefined;
    if ("wav" in m) current.job.resolve(m.wav);
    else current.job.reject(new Error(m.error));
    pump(h);
  };

  const start = (): Host => {
    if (host) return host;
    let settleReady: (error?: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      // Only the first call counts: a promise settles once.
      settleReady = (error) => (error ? reject(error) : resolve());
    });
    ready.catch(() => {}); // generate() alone (without awaiting the load) must not leave it unhandled
    const proc = Bun.spawn({
      cmd: [process.execPath, script, JSON.stringify(data)],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, MOUTHPIECE_CHILD: "1" },
      serialization: "advanced",
      ipc: (message) => onMessage(h, message as KokoroHostReply),
    });
    // Never keep a process alive just for the host (the daemon's server does that).
    proc.unref();
    const stderr = drainTail(proc.stderr);
    const h: Host = {
      proc,
      ready,
      settleReady,
      loaded: false,
      loadTimer: setTimeout(
        () => retire(h, new Error(`kokoro load timed out after ${loadTimeoutMs}ms`)),
        loadTimeoutMs,
      ),
      queue: [],
      current: undefined,
      exited: proc.exited.then(() => {}),
      retired: false,
    };
    h.loadTimer.unref?.();
    void proc.exited.then(async (code) => {
      if (h.retired) return; // we killed it
      const signal = proc.signalCode ?? undefined;
      retire(h, new Error(`kokoro host exited (${signal ? `signal ${signal}` : `code ${code}`})`));
      // At most one line: the exit, with the last line the host wrote to stderr.
      const last = lastLine(await Promise.race([stderr, Bun.sleep(500).then(() => "")]));
      log({
        level: "warn",
        msg: "kokoro_host_exited",
        ...(signal ? { signal } : { code }),
        ...(last ? { stderr: last } : {}),
      });
    });
    host = h;
    return h;
  };

  const engine: KokoroEngine = {
    generate(text, { voice, signal }) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => abandon(job, signal?.reason);
        const job: Job = {
          id: ++seq,
          text,
          voice,
          resolve: (wav) => {
            signal?.removeEventListener("abort", onAbort);
            resolve({ toWav: () => toArrayBuffer(wav) });
          },
          reject: (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const h = start();
        h.queue.push(job);
        pump(h);
        skipAbandoned(h);
      });
    },
  };

  const load = (async () => {
    await start().ready;
    return engine;
  }) as ProcessKokoroLoader;
  load.terminate = async () => {
    const h = host;
    if (!h) return;
    retire(h, new Error("kokoro host terminated"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      h.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TERMINATE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  };
  return load;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

/** Reads `stream` to the end, keeping only its last STDERR_TAIL_CHARS characters. */
async function drainTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for await (const chunk of stream) {
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
    }
  } catch {
    // a closed pipe ends the tail
  }
  return tail;
}

function lastLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return line?.slice(0, 300);
}
