// Usage: bun scripts/summary-eval.ts <transcript.jsonl>... [--limit 20]
// Summarizes real assistant messages with the production summarizer for the US-009 quality review (≥ 18/20 good).

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cleanForSpeech, DEFAULT_CONFIG, isRecord } from "@mouthpiece/core";
import { createSummarizer } from "@mouthpiece/summarizers";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { limit: { type: "string", default: "20" } },
});
const messages: string[] = [];
for (const file of positionals) {
  for (const line of (await Bun.file(file).text()).split("\n")) {
    try {
      const r: unknown = JSON.parse(line);
      if (
        !isRecord(r) ||
        r.type !== "assistant" ||
        !isRecord(r.message) ||
        !Array.isArray(r.message.content)
      )
        continue;
      const text = r.message.content
        .filter((b) => isRecord(b) && b.type === "text")
        .map((b) => String((b as { text: unknown }).text))
        .join("\n");
      const cleaned = cleanForSpeech(text);
      if (cleaned.length > DEFAULT_CONFIG.summarizer.thresholdChars) messages.push(cleaned);
    } catch {}
  }
}
const sample = messages.slice(-Number(values.limit));
const summarizer = createSummarizer(DEFAULT_CONFIG, {
  home: join(homedir(), ".mouthpiece"),
  env: process.env,
});
if (!summarizer) throw new Error("summarizer disabled");
let out =
  "# Summary eval\n\nMark each: would you act the same as if you'd read the full message?\n";
const times: number[] = [];
for (const [i, full] of sample.entries()) {
  const t0 = performance.now();
  const summary = await summarizer.summarize(full, { source: "eval" }).catch((e) => `ERROR: ${e}`);
  times.push(performance.now() - t0);
  out += `\n## ${i + 1} — [ ] good\n\n**Spoken (${summary.length} chars, ${times.at(-1)?.toFixed(0)} ms):** ${summary}\n\n<details><summary>Full (${full.length} chars)</summary>\n\n${full}\n</details>\n`;
}
times.sort((a, b) => a - b);
out += `\n---\nmedian ${times[Math.floor(times.length / 2)]?.toFixed(0)} ms · p90 ${times[Math.floor(times.length * 0.9)]?.toFixed(0)} ms · n=${times.length}\n`;
await Bun.write("summary-eval.md", out);
console.log(`wrote summary-eval.md (${sample.length} samples)`);
