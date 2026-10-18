import { expect, test } from "bun:test";
import { promptVerdict, screenState } from "./screens.ts";

// Recorded from real screens on 2026-10-18 (Claude Code 2.1.302, Codex, Orca 1.4.224), session
// text redacted. U+00A0 is the non-breaking space Orca returns.
const RULE = "─".repeat(60);
const claudeFooter = [
  "  Model: Opus 5.5 | ⎇ main",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
];
const claudeIdle = [
  "  (response text)",
  "✻ Crunched for 25s · done 4:51 PM",
  RULE,
  "❯",
  RULE,
  ...claudeFooter,
];
const claudeBusy = [
  "  ⎿  Running…",
  "✽ Lollygagging… (23s · ↓ 1.9k tokens)",
  RULE,
  "❯",
  RULE,
  ...claudeFooter,
];
const codexIdle = [
  "  (response text)",
  "  Worked for 1m 42s • 3:21 PM",
  "› Ask Codex to do anything",
  "  GPT-5.6-Terra high · ~/code",
  "  ? for shortcuts",
];

test("Claude Code: idle with an empty prompt", () => {
  expect(screenState("claude", claudeIdle)).toEqual({ idle: true, prompt: "" });
});

test("Claude Code: a spinner line means busy", () => {
  expect(screenState("claude", claudeBusy)).toEqual({ idle: false, prompt: "" });
});

test("Claude Code: text at the prompt, including a wrapped line", () => {
  const tail = [
    ...claudeIdle.slice(0, 3),
    "❯ fix the tests but",
    "  don't touch fixtures",
    RULE,
    ...claudeFooter,
  ];
  expect(screenState("claude", tail)).toEqual({
    idle: true,
    prompt: "fix the tests but don't touch fixtures",
  });
});

test("Claude Code: a numbered option after ❯ is a menu, not a prompt", () => {
  const tail = [...claudeIdle.slice(0, 3), "❯ 1. Yes", "  2. No", RULE, ...claudeFooter];
  expect(screenState("claude", tail)).toBeUndefined();
});

test("Claude Code: no prompt box is unrecognized", () => {
  expect(screenState("claude", ["some output", "more output"])).toBeUndefined();
  expect(screenState("claude", ["x", RULE, "not a prompt", RULE])).toBeUndefined();
});

test("Codex: the placeholder means an empty prompt", () => {
  expect(screenState("codex", codexIdle)).toEqual({ idle: true, prompt: "" });
});

test("Codex: typed text, and esc to interrupt means busy", () => {
  const typed = codexIdle.map((l) => (l.startsWith("›") ? "› run the linter" : l));
  expect(screenState("codex", typed)).toEqual({ idle: true, prompt: "run the linter" });
  const busy = ["• Working (12s • esc to interrupt)", ...codexIdle.slice(2)];
  expect(screenState("codex", busy)?.idle).toBe(false);
});

test("Codex without a › line, and any other agent, are unrecognized", () => {
  expect(screenState("codex", ["output"])).toBeUndefined();
  expect(screenState("gemini", claudeIdle)).toBeUndefined();
});

test("promptVerdict: unrecognized, busy, draft and ok", () => {
  expect(promptVerdict(undefined)).toEqual({ ok: false, reason: "unverified" });
  expect(promptVerdict({ idle: false, prompt: "" })).toEqual({ ok: false, reason: "not-idle" });
  expect(promptVerdict({ idle: true, prompt: "half typed" })).toEqual({
    ok: false,
    reason: "draft",
  });
  expect(promptVerdict({ idle: true, prompt: "" })).toEqual({ ok: true });
});

test("promptVerdict with typed text: the prompt must start with it, spacing aside", () => {
  const typed = "fix the tests but don't touch fixtures and then run the whole suite again";
  expect(
    promptVerdict(
      {
        idle: true,
        prompt: "fix the tests but don't touch fix tures and then run the whole suite again",
      },
      typed,
    ),
  ).toEqual({ ok: true });
  expect(promptVerdict({ idle: true, prompt: "" }, typed)).toEqual({ ok: false, reason: "draft" });
  expect(promptVerdict({ idle: true, prompt: "something else" }, typed)).toEqual({
    ok: false,
    reason: "draft",
  });
});
