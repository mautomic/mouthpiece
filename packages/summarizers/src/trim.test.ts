import { expect, test } from "bun:test";
import { trimKeepingLast, trimToSentences } from "./trim.ts";

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

test("trimKeepingLast: the last sentence (the user's to-do) always survives; the middle goes", () => {
  const text =
    "I fixed the race. I also cleaned up the logs. Tests pass. Restart the daemon to load it.";
  expect(trimKeepingLast(text, 60)).toBe("I fixed the race. Restart the daemon to load it.");
  expect(trimKeepingLast(text, 200)).toBe(text);
});

test("trimKeepingLast: a last sentence too long to keep falls back to the first sentences", () => {
  const text = `Short start. ${"word ".repeat(30)}end.`;
  expect(trimKeepingLast(text, 40)).toBe(trimToSentences(text, 40));
});

test("trimKeepingLast never exceeds maxChars", () => {
  const text = "One. Two two. Three three three. Four four four four. Five.";
  for (let max = 5; max <= text.length; max++) {
    expect(trimKeepingLast(text, max).length).toBeLessThanOrEqual(max);
  }
});
