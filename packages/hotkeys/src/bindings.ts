import type { Config } from "@mouthpiece/core";

export const HOTKEY_ACTIONS = ["stop", "skip", "replay", "toggleMode"] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];
const MODIFIERS = ["ctrl", "alt", "shift", "cmd"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** macOS virtual key codes (ANSI layout); must match the table in MouthpieceHotkeys.swift. */
export const KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "9": 25,
  "7": 26,
  "8": 28,
  "0": 29,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
};

export interface Binding {
  action: HotkeyAction;
  key: string;
  modifiers: Modifier[];
}

export function parseBinding(action: HotkeyAction, spec: string): Binding {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key || KEY_CODES[key] === undefined)
    throw new Error(`hotkeys.${action}: unknown key in "${spec}" (use a-z or 0-9)`);
  if (parts.length === 0)
    throw new Error(
      `hotkeys.${action}: "${spec}" needs at least one modifier (ctrl, alt, shift, cmd)`,
    );
  const modifiers = parts.map((p) => {
    if (!(MODIFIERS as readonly string[]).includes(p))
      throw new Error(`hotkeys.${action}: unknown modifier "${p}"`);
    return p as Modifier;
  });
  return { action, key, modifiers: [...new Set(modifiers)] };
}

export function helperArgs(
  hotkeys: Config["hotkeys"],
  target: { url: string; tokenPath: string },
): string[] {
  const args = ["--url", target.url, "--token-file", target.tokenPath];
  const seen = new Map<string, HotkeyAction>();
  for (const action of HOTKEY_ACTIONS) {
    const b = parseBinding(action, hotkeys[action]);
    const combo = `${[...b.modifiers].sort().join("+")}+${b.key}`;
    const clash = seen.get(combo);
    if (clash) throw new Error(`hotkeys.${action} and hotkeys.${clash} are both ${combo}`);
    seen.set(combo, action);
    args.push("--bind", `${action}=${b.modifiers.join("+")}+${b.key}`);
  }
  return args;
}
