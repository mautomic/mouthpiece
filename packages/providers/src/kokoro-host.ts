// Child-process entry (see kokoro-process.ts): `bun kokoro-host.ts <KokoroHostData as JSON>`.
// Kokoro's generate() is synchronous ONNX work that blocks its thread for the whole render (1.4 s
// for 71 chars), so it runs here, off the daemon's event loop, in a process the daemon can kill at
// any time. Not exported from the package index: importing it runs it.
//
// It never calls process.exit(): once onnxruntime has loaded that crashes Bun (exit 134). It ends
// when the daemon kills it, or on its own when the daemon goes away and the IPC channel closes.
import { defaultKokoroLoader } from "./kokoro.ts";
import type { KokoroHostData, KokoroHostReply, KokoroHostRequest } from "./kokoro-process.ts";

const data = JSON.parse(process.argv[2] ?? "{}") as KokoroHostData;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const reply = (message: KokoroHostReply) => process.send?.(message);

const engine = defaultKokoroLoader(data.home, { allowRemoteModels: data.allowRemoteModels })();
engine.then(
  () => reply({ ready: true }),
  (error) => reply({ loadError: describe(error) }),
);

// The daemon sends one request at a time; the chain keeps them in order regardless.
let queue: Promise<void> = Promise.resolve();
process.on("message", (message) => {
  const { id, text, voice, speed } = message as KokoroHostRequest;
  queue = queue.then(async () => {
    try {
      // generate(), never stream(): stream() hangs after the second sentence (US-019).
      const wav = (await (await engine).generate(text, { voice, speed })).toWav();
      reply({ id, wav: new Uint8Array(wav) });
    } catch (error) {
      reply({ id, error: describe(error) });
    }
  });
});
