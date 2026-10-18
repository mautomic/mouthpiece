const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

export function splitSentences(text: string): string[] {
  return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
}

export interface ChunkOptions {
  maxChars: number;
  targetChars?: number;
  /**
   * When set, the first chunk is packed like the rest, up to this many characters. By default the
   * first sentence is a chunk of its own, so speech can start sooner.
   */
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
  const packLimit = Math.min(maxChars, targetChars);
  // A limit of 0 keeps the first sentence on its own.
  let limit = firstChars === undefined ? 0 : Math.min(maxChars, firstChars);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (current && candidate.length > limit) {
      chunks.push(current);
      current = piece;
      limit = packLimit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
