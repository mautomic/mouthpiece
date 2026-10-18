import { describe, expect, test } from "bun:test";
import { chunkText, splitSentences } from "./chunk.ts";

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

describe("splitSentences", () => {
  test("splits on sentence boundaries", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });
  test("empty input", () => {
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("chunkText", () => {
  test("first sentence stands alone, rest are packed", () => {
    expect(chunkText("Short first. Second one. Third one.", { maxChars: 100 })).toEqual([
      "Short first.",
      "Second one. Third one.",
    ]);
  });

  test("respects targetChars when packing", () => {
    const text = "A first. Bb bb bb. Cc cc cc. Dd dd dd.";
    expect(chunkText(text, { maxChars: 100, targetChars: 20 })).toEqual([
      "A first.",
      "Bb bb bb. Cc cc cc.",
      "Dd dd dd.",
    ]);
  });

  test("never exceeds maxChars and loses no text (20 KB, few periods)", () => {
    const text = `${"word ".repeat(1000)}. ${"another sentence here. ".repeat(500)}`;
    const chunks = chunkText(text, { maxChars: 2000 });
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));
  });

  test("splits an over-long sentence at word boundaries", () => {
    const chunks = chunkText("aaaa bbbb cccc dddd.", { maxChars: 10 });
    expect(chunks).toEqual(["aaaa bbbb", "cccc dddd."]);
  });

  test("hard-splits a single giant word", () => {
    const url = "x".repeat(25);
    const chunks = chunkText(url, { maxChars: 10 });
    expect(chunks).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  });

  test("empty text yields no chunks", () => {
    expect(chunkText("", { maxChars: 10 })).toEqual([]);
  });

  test("firstChars splits a long first sentence at its last clause break within the limit", () => {
    const text =
      "I fixed the config reload bug, added a test for it, and confirmed the check passes. Done.";
    expect(chunkText(text, { maxChars: 400, firstChars: 60 })).toEqual([
      "I fixed the config reload bug, added a test for it,",
      "and confirmed the check passes. Done.",
    ]);
  });

  test("firstChars uses the first clause break when none is within the limit", () => {
    const text = "The config reload bug is fixed in the daemon now; a test covers it.";
    expect(chunkText(text, { maxChars: 400, firstChars: 20 })).toEqual([
      "The config reload bug is fixed in the daemon now;",
      "a test covers it.",
    ]);
  });

  test("firstChars splits at a spaced dash, never inside a hyphenated word", () => {
    const text = "The hot-reload path was rewritten — and the tests all pass now.";
    expect(chunkText(text, { maxChars: 400, firstChars: 40 })).toEqual([
      "The hot-reload path was rewritten —",
      "and the tests all pass now.",
    ]);
  });

  test("firstChars leaves a sentence without a usable clause break whole", () => {
    const short = "Short enough already, yes.";
    expect(chunkText(short, { maxChars: 400, firstChars: 80 })).toEqual([short]);
    const noBreak = "This sentence has no clause break anywhere in it at all.";
    expect(chunkText(noBreak, { maxChars: 400, firstChars: 20 })).toEqual([noBreak]);
    // A label prefix ("web: …") is too short to be a chunk on its own.
    const labelled = "web: This sentence has no other clause break in it at all.";
    expect(chunkText(labelled, { maxChars: 400, firstChars: 20 })).toEqual([labelled]);
  });

  test("firstChars loses no text and keeps every chunk within maxChars", () => {
    const text = `${"clause, ".repeat(80)}end. ${"Another sentence here. ".repeat(40)}`;
    const chunks = chunkText(text, { maxChars: 400, targetChars: 150, firstChars: 80 });
    expect(chunks[0]?.length).toBeLessThanOrEqual(80);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));
  });

  test("rejects maxChars < 1", () => {
    expect(() => chunkText("x", { maxChars: 0 })).toThrow(RangeError);
  });
});
