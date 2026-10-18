const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

export function splitSentences(text: string): string[] {
  return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
}

export interface ChunkOptions {
  maxChars: number;
  targetChars?: number;
  /** When set, a longer first sentence is split at a clause break so the first chunk is short. */
  firstChars?: number;
}

export function chunkText(
  text: string,
  { maxChars, targetChars = 500, firstChars }: ChunkOptions,
): string[] {
  if (maxChars < 1) throw new RangeError("maxChars must be >= 1");
  const pieces = splitSentences(text).flatMap((s) =>
    s.length <= maxChars ? [s] : splitLong(s, maxChars),
  );
  if (firstChars !== undefined && pieces[0] !== undefined) {
    pieces.splice(0, 1, ...splitClause(pieces[0], firstChars));
  }
  const [first, ...rest] = pieces;
  if (first === undefined) return [];
  const packLimit = Math.min(maxChars, targetChars);
  const chunks = [first];
  let current = "";
  for (const piece of rest) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (current && candidate.length > packLimit) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** A clause shorter than this (e.g. a "web:" label prefix) is not worth a chunk of its own. */
const MIN_CLAUSE_CHARS = 12;
/** After `,` `;` or `:`, or after a dash with spaces around it (never a hyphen inside a word). */
const CLAUSE_BREAK = /[,;:](?=\s)|\s[-–—](?=\s)/g;

/**
 * Splits a sentence longer than `maxChars` in two at its last clause break within `maxChars`, or
 * at its first break when none is that early. A sentence without a usable break stays whole.
 */
function splitClause(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const ends = [...sentence.matchAll(CLAUSE_BREAK)]
    .map((m) => m.index + m[0].length)
    .filter((end) => end >= MIN_CLAUSE_CHARS && end < sentence.length - 1);
  const end = ends.findLast((e) => e <= maxChars) ?? ends[0];
  if (end === undefined) return [sentence];
  return [sentence.slice(0, end).trim(), sentence.slice(end).trim()];
}

function splitLong(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/).filter(Boolean)) {
    for (const part of hardSplit(word, maxChars)) {
      const candidate = current ? `${current} ${part}` : part;
      if (candidate.length > maxChars) {
        out.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

function hardSplit(word: string, maxChars: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < word.length; i += maxChars) parts.push(word.slice(i, i + maxChars));
  return parts;
}
