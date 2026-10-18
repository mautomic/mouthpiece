import type { ReplyCheck } from "@mouthpiece/core";

/** What an agent's rendered screen says: is it idle, and what is at its prompt? */
export interface ScreenState {
  idle: boolean;
  prompt: string;
}

const RULE = /^─{8,}/;
/**
 * A working line: a status glyph, any words, an ellipsis, then the elapsed time in parentheses
 * (`✽ Lollygagging… (23s`, `✶ Running the test suite… (1m 3s`). Prose that happens to match only
 * refuses a reply, the safe direction.
 */
const CLAUDE_BUSY = /^\S\s.*…\s*\(/;
const ESC_TO_INTERRUPT = /esc to interrupt/i;
const CLAUDE_MENU = /^❯\s*\d+\./;
const CODEX_PLACEHOLDER = "Ask Codex to do anything";

/**
 * Reads the screen of a known agent (as seen 2026-10-18: Claude Code 2.1.302, Codex in Orca
 * 1.4.224). Undefined for any screen it does not recognize, so the caller refuses rather than
 * types blind.
 */
export function screenState(agent: string, tail: string[]): ScreenState | undefined {
  const lines = tail.map((l) => l.replace(/ /g, " "));
  if (agent === "claude") return claude(lines);
  if (agent === "codex") return codex(lines);
  return undefined;
}

function claude(lines: string[]): ScreenState | undefined {
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []));
  if (rules.length < 2) return undefined;
  const [top, bottom] = rules.slice(-2) as [number, number];
  const box = lines.slice(top + 1, bottom);
  if (!box[0]?.startsWith("❯") || box.some((l) => CLAUDE_MENU.test(l))) return undefined;
  const prompt = box
    .map((l, i) => (i === 0 ? l.slice(1) : l).trim())
    .filter(Boolean)
    .join(" ");
  const above = lines.slice(0, top);
  return { idle: !above.some((l) => CLAUDE_BUSY.test(l) || ESC_TO_INTERRUPT.test(l)), prompt };
}

function codex(lines: string[]): ScreenState | undefined {
  const i = lines.findLastIndex((l) => l.startsWith("›"));
  if (i < 0) return undefined;
  const text = (lines[i] as string).slice(1).trim();
  return {
    idle: !lines.some((l) => ESC_TO_INTERRUPT.test(l)),
    prompt: text === CODEX_PLACEHOLDER ? "" : text,
  };
}

/** The check result for a screen: empty and idle, or (with `typed`) idle and starting with it. */
export function promptVerdict(state: ScreenState | undefined, typed?: string): ReplyCheck {
  if (!state) return { ok: false, reason: "unverified" };
  if (!state.idle) return { ok: false, reason: "not-idle" };
  if (typed === undefined) {
    return state.prompt === "" ? { ok: true } : { ok: false, reason: "draft" };
  }
  const want = squash(typed).slice(0, 40);
  return want !== "" && squash(state.prompt).startsWith(want)
    ? { ok: true }
    : { ok: false, reason: "draft" };
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}
