// Usage: [INWORLD_API_KEY=…] bun scripts/bakeoff.ts [sayVoice…]
// Writes bakeoff/<provider>-<sample>.<ext> and bakeoff/results.md. Calls paid APIs only if INWORLD_API_KEY is set.
import { mkdir } from "node:fs/promises";
import type { TtsProvider } from "@mouthpiece/core";
import { InworldProvider, SayProvider } from "@mouthpiece/providers";

const SAMPLES = {
  status: "Tests pass. Ready for review.",
  summary:
    "I refactored the speech queue so alerts jump ahead of normal responses without interrupting what is playing. All twelve queue tests pass. One question for you: should a new response from the same session cut off the current one, or wait?",
  long: "I went through the provider chain end to end. ".repeat(40),
};

const providers: TtsProvider[] = [];
const sayVoices = process.argv.slice(2);
for (const voice of sayVoices.length ? sayVoices : [undefined]) {
  providers.push(
    Object.assign(new SayProvider({ tmpDir: "bakeoff/tmp", voice }), {
      name: `say${voice ? `-${voice}` : ""}`,
    }),
  );
}
const key = process.env.INWORLD_API_KEY;
if (key) {
  for (const model of ["inworld-tts-2-flash", "inworld-tts-2"]) {
    providers.push(
      Object.assign(new InworldProvider({ apiKey: key, model, voice: "Ashley" }), { name: model }),
    );
  }
}

await mkdir("bakeoff", { recursive: true });
const rows = [
  "| provider | sample | chars | headers ms | first chunk ms | total ms |",
  "|---|---|---|---|---|---|",
];
for (const provider of providers) {
  for (const [sample, text] of Object.entries(SAMPLES)) {
    const t0 = performance.now();
    const clip = await provider.synthesize(text.slice(0, provider.maxCharsPerRequest));
    const headers = performance.now() - t0;
    const parts: Uint8Array[] = [];
    let first = 0;
    for await (const part of clip.chunks) {
      if (!first) first = performance.now() - t0;
      parts.push(part);
    }
    const total = performance.now() - t0;
    await Bun.write(`bakeoff/${provider.name}-${sample}.${clip.format}`, Buffer.concat(parts));
    rows.push(
      `| ${provider.name} | ${sample} | ${text.length} | ${headers.toFixed(0)} | ${first.toFixed(0)} | ${total.toFixed(0)} |`,
    );
  }
}
await Bun.write("bakeoff/results.md", `${rows.join("\n")}\n`);
console.log(rows.join("\n"));
