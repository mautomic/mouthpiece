import type { KokoroEngine, KokoroLoader } from "./kokoro.ts";
import type { KokoroWorkerData, KokoroWorkerReply, KokoroWorkerRequest } from "./kokoro-worker.ts";

export interface WorkerKokoroOptions {
  /** Default false: only the model `mouthpiece kokoro install` downloaded is used. */
  allowRemoteModels?: boolean;
  /** Test seam: the worker entry (default `./kokoro-worker.ts`), speaking the same protocol. */
  workerUrl?: string | URL;
}

/** A loader whose engine runs in a Bun Worker. */
export interface WorkerKokoroLoader extends KokoroLoader {
  /**
   * Stops the worker, rejecting its pending requests, and resolves once it has closed (at most
   * TERMINATE_WAIT_MS). Await it before the process exits: a process that exits while a worker
   * with onnxruntime loaded is still shutting down crashes Bun (exit 134, "A C++ exception").
   */
  terminate(): Promise<void>;
}

const TERMINATE_WAIT_MS = 2_000;

interface Pending {
  resolve(wav: ArrayBuffer): void;
  reject(error: Error): void;
}

/** One live worker: its load state and the requests it still owes a reply. */
interface Running {
  worker: Worker;
  ready: Promise<void>;
  settleReady(error?: Error): void;
  pending: Map<number, Pending>;
  /** Resolves on the worker's `close` event. */
  closed: Promise<void>;
}

/**
 * Kokoro off the main thread. An in-process `generate()` blocks the event loop for the whole
 * render (seconds for a long chunk), which starves HTTP requests, hooks and timers; in a Worker the
 * daemon stays responsive.
 *
 * The worker starts on first use. If it crashes, exits or fails to load the engine, every pending
 * request rejects and the next call starts a fresh worker. An abort can't cancel a render in
 * progress: its late reply resolves a promise nobody awaits (KokoroProvider checks the signal).
 */
export function workerKokoroLoader(
  home: string,
  opts: WorkerKokoroOptions = {},
): WorkerKokoroLoader {
  const url = opts.workerUrl ?? new URL("./kokoro-worker.ts", import.meta.url);
  const workerData: KokoroWorkerData = { home, allowRemoteModels: opts.allowRemoteModels ?? false };
  let running: Running | undefined;
  let seq = 0;

  /** Retires `r` (if still current): rejects its load and every pending request. */
  const fail = (r: Running, error: Error) => {
    if (running !== r) return;
    running = undefined;
    r.settleReady(error);
    for (const p of r.pending.values()) p.reject(error);
    r.pending.clear();
    r.worker.terminate();
  };

  const start = (): Running => {
    if (running) return running;
    const worker = new Worker(url, { workerData } as WorkerOptions);
    // Never keep a process alive just for the worker (the daemon's server does that).
    (worker as Worker & { unref(): void }).unref();
    let settleReady: (error?: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      // Only the first call counts: a promise settles once.
      settleReady = (error) => (error ? reject(error) : resolve());
    });
    ready.catch(() => {}); // generate() alone (without awaiting the load) must not leave it unhandled
    const closed = new Promise<void>((resolve) =>
      worker.addEventListener("close", () => resolve()),
    );
    const r: Running = {
      worker,
      ready,
      settleReady,
      pending: new Map(),
      closed,
    };
    worker.addEventListener("message", (event: MessageEvent<KokoroWorkerReply>) => {
      const m = event.data;
      if ("ready" in m) return r.settleReady();
      if ("loadError" in m) return fail(r, new Error(m.loadError));
      const p = r.pending.get(m.id);
      if (!p) return;
      r.pending.delete(m.id);
      if ("wav" in m) p.resolve(m.wav);
      else p.reject(new Error(m.error));
    });
    worker.addEventListener("error", (event) => {
      fail(
        r,
        new Error(`kokoro worker crashed: ${(event as ErrorEvent).message ?? "unknown error"}`),
      );
    });
    worker.addEventListener("close", (event) => {
      fail(r, new Error(`kokoro worker exited (code ${(event as CloseEvent).code})`));
    });
    running = r;
    return r;
  };

  const engine: KokoroEngine = {
    async generate(text, { voice }) {
      const r = start();
      const id = ++seq;
      const wav = new Promise<ArrayBuffer>((resolve, reject) =>
        r.pending.set(id, { resolve, reject }),
      );
      const request: KokoroWorkerRequest = { id, text, voice };
      r.worker.postMessage(request); // the worker holds it until its engine has loaded
      const buffer = await wav;
      return { toWav: () => buffer };
    },
  };

  const load = (async () => {
    await start().ready;
    return engine;
  }) as WorkerKokoroLoader;
  load.terminate = async () => {
    const r = running;
    if (!r) return;
    fail(r, new Error("kokoro worker terminated"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      r.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TERMINATE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  };
  return load;
}
