// Usage: MOUTHPIECE_HOME=… bun scripts/kokoro-warm.ts
// Run by `mouthpiece kokoro install` after `bun add kokoro-js`: downloads the Kokoro model into
// <home>/kokoro/hf (remote models allowed only here), renders one phrase, and prints
// {"loadMs":…,"generateMs":…} as the last stdout line.
import { mouthpieceHome } from "@mouthpiece/core";
import { defaultKokoroLoader } from "@mouthpiece/providers";

try {
  const home = mouthpieceHome(process.env);
  const t0 = performance.now();
  const engine = await defaultKokoroLoader(home, { allowRemoteModels: true })();
  const t1 = performance.now();
  // generate(), never stream(): stream() hangs after the second sentence.
  await engine.generate("Ready.", { voice: "af_heart" });
  const t2 = performance.now();
  console.log(JSON.stringify({ loadMs: Math.round(t1 - t0), generateMs: Math.round(t2 - t1) }));
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
// The phonemizer's WASM prints stack traces when a process exits naturally; exit explicitly.
process.exit(0);
