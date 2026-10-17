import { expect, test } from "bun:test";
import { shouldSpeak } from "./filter.ts";

const opts = { minChars: 5, trivial: ["done", "got it"] };

test.each([
  ["Done.", false],
  ["  GOT IT!  ", false],
  ["Hi.", false],
  ["Done with the refactor.", true],
  ["", false],
])("%p -> %p", (text, expected) => {
  expect(shouldSpeak(text, opts)).toBe(expected);
});
