// Usage: MOUTHPIECE_HOME=… bun scripts/kokoro-warm.ts
// Run by `mouthpiece kokoro install` after `bun add kokoro-js`: downloads the Kokoro model into
// <home>/kokoro/hf (remote models allowed only here), renders one phrase, and prints
// {"loadMs":…,"generateMs":…} as the last stdout line. MOUTHPIECE_KOKORO_OFFLINE=1 uses only the
// cached model (for tests against an existing install).
//
// The script ends on its own: no process.exit(). Calling process.exit() after onnxruntime has
// loaded makes Bun crash (exit 134, "A C++ exception occurred") after the timing line is printed.
import { mouthpieceHome } from "@mouthpiece/core";
import { defaultKokoroLoader } from "@mouthpiece/providers";

try {
  const home = mouthpieceHome(process.env);
  const t0 = performance.now();
  const engine = await defaultKokoroLoader(home, {
    allowRemoteModels: process.env.MOUTHPIECE_KOKORO_OFFLINE !== "1",
  })();
  const t1 = performance.now();
  // generate(), never stream(): stream() hangs after the second sentence.
  await engine.generate("Ready.", { voice: "af_heart" });
  const t2 = performance.now();
  console.log(JSON.stringify({ loadMs: Math.round(t1 - t0), generateMs: Math.round(t2 - t1) }));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
