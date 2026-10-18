import { splitSentences } from "@mouthpiece/core";

/** Whole sentences up to maxChars; a single over-long first sentence is cut at a word boundary with "…". */
export function trimToSentences(text: string, maxChars: number): string {
  const sentences = splitSentences(text);
  let out = "";
  for (const sentence of sentences) {
    const candidate = out ? `${out} ${sentence}` : sentence;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  if (out) return out;
  const first = sentences[0] ?? text.trim();
  if (first.length <= maxChars) return first;
  // Look one char further than we keep, so a word ending exactly at maxChars - 1 survives.
  const lastSpace = first.slice(0, maxChars).lastIndexOf(" ");
  const kept = lastSpace > 0 ? first.slice(0, lastSpace) : first.slice(0, maxChars - 1);
  return `${kept.trimEnd()}…`;
}
