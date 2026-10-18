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

  test("firstChars packs the first chunk like the rest instead of leaving its sentence alone", () => {
    expect(chunkText("One. Two. Three.", { maxChars: 100, firstChars: 100 })).toEqual([
      "One. Two. Three.",
    ]);
    const text = "A first. Bb bb bb. Cc cc cc. Dd dd dd.";
    expect(chunkText(text, { maxChars: 100, firstChars: 20, targetChars: 10 })).toEqual([
      "A first. Bb bb bb.",
      "Cc cc cc.",
      "Dd dd dd.",
    ]);
  });

  test("firstChars never exceeds maxChars and loses no text", () => {
    const text = `${"Another sentence here. ".repeat(40)}`;
    const chunks = chunkText(text, { maxChars: 100, firstChars: 400, targetChars: 400 });
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));
  });

  test("rejects maxChars < 1", () => {
    expect(() => chunkText("x", { maxChars: 0 })).toThrow(RangeError);
  });
});
