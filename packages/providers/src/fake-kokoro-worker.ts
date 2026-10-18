// Test worker: speaks the kokoro-worker protocol with a fake engine, so tests don't need kokoro-js.
// The reply's "WAV" is `<threadId>|<voice>|<text>`, so a test can tell workers apart. Special texts:
// "error" replies with an error, "crash" throws (the worker dies), "exit" calls process.exit(1),
// "hang" never replies, and "slow…" replies after 50 ms. Home "fail-load" fails the engine load.
import { threadId, workerData } from "node:worker_threads";
import type { KokoroWorkerData, KokoroWorkerReply, KokoroWorkerRequest } from "./kokoro-worker.ts";

declare const self: Worker;

const data = workerData as KokoroWorkerData;
const reply = (message: KokoroWorkerReply, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

if (data.home === "fail-load") reply({ loadError: "model missing" });
else reply({ ready: true });

self.addEventListener("message", async (event: MessageEvent<KokoroWorkerRequest>) => {
  const { id, text, voice } = event.data;
  if (text === "hang") return;
  if (text === "crash") throw new Error("engine crashed");
  if (text === "exit") process.exit(1);
  if (text === "error") return reply({ id, error: "generate failed" });
  if (text.startsWith("slow")) await Bun.sleep(50);
  const wav = new TextEncoder().encode(`${threadId}|${voice}|${text}`).buffer as ArrayBuffer;
  reply({ id, wav }, [wav]);
});
