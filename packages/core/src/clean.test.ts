import { describe, expect, test } from "bun:test";
import { cleanForSpeech } from "./clean.ts";

describe("cleanForSpeech", () => {
  test.each([
    ["## Summary", "Summary."],
    ["**Bold** and *italic* and __under__ and ~~gone~~", "Bold and italic and under and gone."],
    ["keep snake_case_names and 2*3*4 intact", "keep snake_case_names and 2*3*4 intact."],
    ["See [the docs](https://example.com/x) now", "See the docs now."],
    ["![diagram](img.png) shows it", "diagram shows it."],
    ["Open https://www.github.com/foo/bar?x=1 later", "Open link to github.com later."],
    ["Edited /Users/Mau/code/x/src/foo.ts today", "Edited foo.ts today."],
    ["Edited `/Users/Mau/code/x/src/foo.ts` today", "Edited foo.ts today."],
    ["Run `bun test` now", "Run bun test now."],
    ["Run `bun test packages/core/src/clean.test.ts --watch --bail` now", "Run (code) now."],
    ["- first\n- second", "first. second."],
    ["1. one\n2) two", "one. two."],
    ["- [x] done item", "done item."],
    ["> quoted text", "quoted text."],
    ["Above\n\n---\n\nBelow", "Above. Below."],
    ["Line one\nLine two!", "Line one. Line two!"],
    ["Here is the plan:\n- a", "Here is the plan: a."],
    ["Use <kbd>Ctrl</kbd> here", "Use Ctrl here."],
    ["Windows\r\nline", "Windows. line."],
    ["Ship it 🚀", "Ship it 🚀."],
    ["", ""],
  ])("%p", (input, expected) => {
    expect(cleanForSpeech(input)).toBe(expected);
  });

  test("fenced code becomes a line count", () => {
    expect(cleanForSpeech("Before\n```ts\nconst a = 1;\nconst b = 2;\n```\nAfter")).toBe(
      "Before. (code block, 2 lines). After.",
    );
  });

  test("unclosed fence swallows the rest", () => {
    expect(cleanForSpeech("Before\n```\nx\ny")).toBe("Before. (code block, 2 lines).");
  });

  test("code-ish content inside inline code is not mangled by emphasis rules", () => {
    expect(cleanForSpeech("Call `f(*args)` here")).toBe("Call f(*args) here.");
  });

  test("tables read as comma-separated rows", () => {
    expect(cleanForSpeech("| Name | Cost |\n|---|---:|\n| Inworld | $27 |")).toBe(
      "Name, Cost. Inworld, $27.",
    );
  });

  test("links with a title, with parens in the URL, and nested brackets", () => {
    expect(cleanForSpeech('See [docs](https://x.dev/a "Title") now')).toBe("See docs now.");
    expect(cleanForSpeech("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now")).toBe(
      "See Foo now.",
    );
    expect(cleanForSpeech("![a [b] c](x.png) ok")).toBe("![a [b] c](x.png) ok.");
  });

  test("unclosed emphasis and tags are left alone", () => {
    expect(cleanForSpeech("a *b *c")).toBe("a *b *c.");
    expect(cleanForSpeech("_foo_bar_ and *2*3* and **a*b**")).toBe("foo_bar and 2*3 and a*b.");
    expect(cleanForSpeech("1 < 2 and <b>bold</b>")).toBe("1 < 2 and bold.");
  });

  // Review Focus #4: hostile input must not stall the daemon's event loop.
  test.each([
    "[",
    "![",
    "<a",
    "[a](",
    "![a](",
    "```x\n",
    "~~~x\n",
    " *a",
    " _a",
    " **a",
    " ~~a",
    "`a",
  ])("cleans 100k chars of %p in linear time", (unit) => {
    const input = unit.repeat(Math.ceil(100_000 / unit.length));
    const started = performance.now();
    cleanForSpeech(input);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
