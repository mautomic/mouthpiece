// Worker entry (see kokoro-worker-loader.ts). Kokoro's generate() is synchronous ONNX work that
// blocks its thread for the whole render (1.4 s for 71 chars), so it runs here, off the daemon's
// event loop. Not exported from the package index: importing it runs it.
import { workerData } from "node:worker_threads";
import { defaultKokoroLoader } from "./kokoro.ts";

/** Passed as `workerData`. */
export interface KokoroWorkerData {
  home: string;
  allowRemoteModels: boolean;
}

/** Main thread → worker: render `text`. */
export interface KokoroWorkerRequest {
  id: number;
  text: string;
  voice: string;
}

/**
 * Worker → main thread. `ready` / `loadError` once, after the engine load; then one `wav`
 * (transferred) or `error` per request, by id.
 */
export type KokoroWorkerReply =
  | { ready: true }
  | { loadError: string }
  | { id: number; wav: ArrayBuffer }
  | { id: number; error: string };

declare const self: Worker;

const data = workerData as KokoroWorkerData;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const reply = (message: KokoroWorkerReply, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

const engine = defaultKokoroLoader(data.home, { allowRemoteModels: data.allowRemoteModels })();
engine.then(
  () => reply({ ready: true }),
  (error) => reply({ loadError: describe(error) }),
);

// One render at a time, in arrival order.
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<KokoroWorkerRequest>) => {
  const { id, text, voice } = event.data;
  queue = queue.then(async () => {
    try {
      // generate(), never stream(): stream() hangs after the second sentence (US-019).
      const wav = (await (await engine).generate(text, { voice })).toWav();
      reply({ id, wav }, [wav]);
    } catch (error) {
      reply({ id, error: describe(error) });
    }
  });
});
