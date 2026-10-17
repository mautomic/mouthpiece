import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG } from "@mouthpiece/core";
import { helperArgs, KEY_CODES, parseBinding } from "./bindings.ts";
import { HOTKEYS_SOURCE } from "./build.ts";

test("parses modifiers and keys case-insensitively", () => {
  expect(parseBinding("stop", "Ctrl+Alt+S")).toEqual({
    action: "stop",
    key: "s",
    modifiers: ["ctrl", "alt"],
  });
});

test.each([
  ["s", "at least one modifier"],
  ["ctrl+alt+f13", "unknown key"],
  ["hyper+s", "unknown modifier"],
])("rejects %p", (spec, message) => {
  expect(() => parseBinding("stop", spec)).toThrow(message);
});

test("helperArgs builds --bind flags for defaults", () => {
  expect(
    helperArgs(DEFAULT_CONFIG.hotkeys, { url: "http://127.0.0.1:7317", tokenPath: "/h/token" }),
  ).toEqual([
    "--url",
    "http://127.0.0.1:7317",
    "--token-file",
    "/h/token",
    "--bind",
    "stop=ctrl+alt+s",
    "--bind",
    "skip=ctrl+alt+n",
    "--bind",
    "replay=ctrl+alt+r",
    "--bind",
    "toggleMode=ctrl+alt+m",
  ]);
});

test("duplicate binding rejected", () => {
  expect(() =>
    helperArgs({ ...DEFAULT_CONFIG.hotkeys, skip: "alt+ctrl+s" }, { url: "u", tokenPath: "t" }),
  ).toThrow("both");
});

test("Swift key-code table matches KEY_CODES", async () => {
  const swift = await readFile(HOTKEYS_SOURCE, "utf8");
  const table = Object.fromEntries(
    [...swift.matchAll(/"([a-z0-9])": (\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
  expect(table).toEqual(KEY_CODES);
});
