import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG } from "@mouthpiece/core";
import {
  type HelperConfig,
  helperArgs,
  helperWanted,
  KEY_CODES,
  parseBinding,
} from "./bindings.ts";
import { HELPER_SOURCE } from "./build.ts";

const target = { url: "http://127.0.0.1:7317", tokenPath: "/h/token" };
const HEAD = ["--url", "http://127.0.0.1:7317", "--token-file", "/h/token"];
const BINDS = [
  "--bind",
  "stop=ctrl+alt+s",
  "--bind",
  "skip=ctrl+alt+n",
  "--bind",
  "replay=ctrl+alt+r",
  "--bind",
  "toggleMode=ctrl+alt+m",
];

function cfg(
  on: { hotkeys?: boolean; menubar?: boolean; micPause?: boolean } = {},
  micPause: Partial<HelperConfig["micPause"]> = {},
): HelperConfig {
  return {
    hotkeys: { ...DEFAULT_CONFIG.hotkeys, enabled: on.hotkeys ?? true },
    menubar: { enabled: on.menubar ?? true },
    micPause: { ...DEFAULT_CONFIG.micPause, ...micPause, enabled: on.micPause ?? true },
  };
}

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

test("helperArgs with every feature enabled (defaults)", () => {
  expect(helperArgs(DEFAULT_CONFIG, target)).toEqual([
    ...HEAD,
    ...BINDS,
    "--menubar",
    "--mic-pause",
    "--mic-resume-delay",
    "800",
  ]);
});

test("helperArgs: hotkeys only", () => {
  expect(helperArgs(cfg({ menubar: false, micPause: false }), target)).toEqual([...HEAD, ...BINDS]);
});

test("helperArgs: menubar only has no --bind flags", () => {
  expect(helperArgs(cfg({ hotkeys: false, micPause: false }), target)).toEqual([
    ...HEAD,
    "--menubar",
  ]);
});

test("helperArgs: mic pause only, with ignored bundle ids and resume delay", () => {
  const c = cfg(
    { hotkeys: false, menubar: false },
    { ignoreBundleIds: ["us.zoom.xos", "com.apple.FaceTime"], resumeDelayMs: 1500 },
  );
  expect(helperArgs(c, target)).toEqual([
    ...HEAD,
    "--mic-pause",
    "--mic-resume-delay",
    "1500",
    "--mic-ignore",
    "us.zoom.xos",
    "--mic-ignore",
    "com.apple.FaceTime",
  ]);
});

test("helperArgs: hotkeys and mic pause without menubar", () => {
  expect(helperArgs(cfg({ menubar: false }), target)).toEqual([
    ...HEAD,
    ...BINDS,
    "--mic-pause",
    "--mic-resume-delay",
    "800",
  ]);
});

test("helperArgs: disabled hotkeys are not validated", () => {
  const c = cfg({ hotkeys: false });
  c.hotkeys = { ...c.hotkeys, skip: c.hotkeys.stop };
  expect(helperArgs(c, target)).not.toContain("--bind");
});

test("helperArgs: everything disabled throws", () => {
  expect(() =>
    helperArgs(cfg({ hotkeys: false, menubar: false, micPause: false }), target),
  ).toThrow("no helper feature");
});

test("helperArgs still accepts a bare hotkeys table (Phase 2 callers)", () => {
  expect(helperArgs(DEFAULT_CONFIG.hotkeys, target)).toEqual([...HEAD, ...BINDS]);
});

test("helperWanted reports whether any feature is enabled", () => {
  expect(helperWanted(DEFAULT_CONFIG)).toBe(true);
  expect(helperWanted(cfg({ hotkeys: true, menubar: false, micPause: false }))).toBe(true);
  expect(helperWanted(cfg({ hotkeys: false, menubar: true, micPause: false }))).toBe(true);
  expect(helperWanted(cfg({ hotkeys: false, menubar: false, micPause: true }))).toBe(true);
  expect(helperWanted(cfg({ hotkeys: false, menubar: false, micPause: false }))).toBe(false);
});

test("duplicate binding rejected", () => {
  const c = cfg();
  c.hotkeys = { ...c.hotkeys, skip: "alt+ctrl+s" };
  expect(() => helperArgs(c, { url: "u", tokenPath: "t" })).toThrow("both");
});

test("Swift key-code table matches KEY_CODES", async () => {
  const swift = await readFile(HELPER_SOURCE, "utf8");
  const table = Object.fromEntries(
    [...swift.matchAll(/"([a-z0-9])": (\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
  expect(table).toEqual(KEY_CODES);
});
