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
  on: { hotkeys?: boolean; menubar?: boolean; micPause?: boolean; reply?: boolean } = {},
  micPause: Partial<HelperConfig["micPause"]> = {},
): HelperConfig {
  return {
    hotkeys: { ...DEFAULT_CONFIG.hotkeys, enabled: on.hotkeys ?? true },
    menubar: { enabled: on.menubar ?? true },
    micPause: { ...DEFAULT_CONFIG.micPause, ...micPause, enabled: on.micPause ?? true },
    reply: { ...DEFAULT_CONFIG.reply, enabled: on.reply ?? false },
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
    "--mic-refresh",
    "200000",
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
    "--mic-refresh",
    "200000",
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
    "--mic-refresh",
    "200000",
  ]);
});

test("helperArgs: the mic pause is refreshed every third of maxPauseMs, at least every 5 s", () => {
  const refresh = (maxPauseMs: number) => {
    const args = helperArgs(cfg({ hotkeys: false, menubar: false }, { maxPauseMs }), target);
    return args[args.indexOf("--mic-refresh") + 1];
  };
  expect(refresh(600_000)).toBe("200000");
  expect(refresh(60_001)).toBe("20000");
  expect(refresh(9_000)).toBe("5000");
  expect(helperArgs(cfg({ micPause: false }), target)).not.toContain("--mic-refresh");
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

test("with replies off there is no inbox and no inbox hotkey", () => {
  const args = helperArgs(cfg(), target);
  expect(args).not.toContain("--inbox");
  expect(args.join(" ")).not.toContain("inbox=");
});

test("with replies on the helper gets the inbox, its pop-up mode and its hotkey", () => {
  const c = cfg({ reply: true });
  const args = helperArgs(c, target);
  expect(args).toEqual(
    expect.arrayContaining(["--bind", "inbox=ctrl+alt+o", "--inbox", "--inbox-popup", "away"]),
  );
  c.reply = { ...c.reply, popup: "always" };
  expect(helperArgs(c, target).slice(-2)).toEqual(["--inbox-popup", "always"]);
});

test("replies alone are enough to want the helper", () => {
  expect(helperWanted(cfg({ hotkeys: false, menubar: false, micPause: false, reply: true }))).toBe(
    true,
  );
});

test("the inbox hotkey clashing with another is rejected only while it is bound", () => {
  const c = cfg({ reply: true });
  c.hotkeys = { ...c.hotkeys, inbox: "ctrl+alt+s" };
  expect(() => helperArgs(c, target)).toThrow("both");
  c.reply = { ...c.reply, enabled: false };
  expect(() => helperArgs(c, target)).not.toThrow();
});
