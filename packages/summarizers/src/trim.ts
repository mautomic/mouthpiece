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

/**
 * Whole sentences up to maxChars, always keeping the last one, where a summary ends with what the
 * user needs to do: sentences are dropped from the middle, not the end. Falls back to
 * trimToSentences when the last sentence alone doesn't fit.
 */
export function trimKeepingLast(text: string, maxChars: number): string {
  const sentences = splitSentences(text);
  const last = sentences.at(-1);
  if (last === undefined || sentences.join(" ").length <= maxChars) return sentences.join(" ");
  if (last.length > maxChars) return trimToSentences(text, maxChars);
  const head = trimToSentences(sentences.slice(0, -1).join(" "), maxChars - last.length - 1);
  // trimToSentences cuts an over-long first sentence with "…"; better to say only the last one.
  return head && !head.endsWith("…") ? `${head} ${last}` : last;
}
