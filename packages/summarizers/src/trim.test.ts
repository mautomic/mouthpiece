import { expect, test } from "bun:test";
import { trimToSentences } from "./trim.ts";

test("keeps whole sentences within the limit", () => {
  expect(trimToSentences("One two. Three four. Five six.", 20)).toBe("One two. Three four.");
});
test("returns text unchanged when it fits", () => {
  expect(trimToSentences("Short.", 100)).toBe("Short.");
});
test("cuts a single over-long sentence at a word with an ellipsis", () => {
  expect(trimToSentences("alpha beta gamma delta epsilon", 17)).toBe("alpha beta gamma…");
});
test("never exceeds maxChars", () => {
  const out = trimToSentences("word ".repeat(200), 50);
  expect(out.length).toBeLessThanOrEqual(50);
});
