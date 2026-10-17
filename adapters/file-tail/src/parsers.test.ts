import { expect, test } from "bun:test";
import { PARSERS } from "./parsers.ts";

const CODEX_FILE =
  "/h/.codex/sessions/2026/10/17/rollout-2026-10-17T12-00-00-0199f0aa-1234-7abc-8def-0123456789ab.jsonl";
const GEMINI_FILE = "/h/.gemini/tmp/3f2a9c/chats/session-2026-10-17T12-00-a1b2c3d4.jsonl";

const codexLine = (payload: Record<string, unknown>, type = "event_msg") =>
  JSON.stringify({ timestamp: "2026-10-17T12:00:01.000Z", type, payload });

test("codex: task_complete yields the final answer with the rollout's uuid", () => {
  expect(
    PARSERS.codex(
      codexLine({ type: "task_complete", turn_id: "t1", last_agent_message: "All **done**." }),
      CODEX_FILE,
    ),
  ).toEqual({ text: "All **done**.", conversationId: "0199f0aa-1234-7abc-8def-0123456789ab" });
});

test("codex: a file name without a uuid leaves conversationId unset", () => {
  expect(
    PARSERS.codex(codexLine({ type: "task_complete", last_agent_message: "x" }), "/tmp/a.jsonl"),
  ).toEqual({ text: "x", conversationId: undefined });
});

test.each([
  [
    "response_item commentary",
    codexLine(
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Looking…" }],
      },
      "response_item",
    ),
  ],
  ["agent_message event", codexLine({ type: "agent_message", message: "Working on it" })],
  ["task_started", codexLine({ type: "task_started" })],
  ["null final message", codexLine({ type: "task_complete", last_agent_message: null })],
  ["blank final message", codexLine({ type: "task_complete", last_agent_message: "  " })],
  ["session_meta", codexLine({ id: "x", cwd: "/x" }, "session_meta")],
  ["garbage", "{not json"],
  ["a JSON array", "[1,2]"],
  ["empty", ""],
])("codex: %s → null", (_name, line) => {
  expect(PARSERS.codex(line, CODEX_FILE)).toBeNull();
});

test("gemini: a gemini message with string content", () => {
  expect(
    PARSERS.gemini(
      JSON.stringify({ id: "m2", timestamp: "t", type: "gemini", content: "Fixed it." }),
      GEMINI_FILE,
    ),
  ).toEqual({ text: "Fixed it.", conversationId: "a1b2c3d4" });
});

test("gemini: a parts array is joined with newlines", () => {
  expect(
    PARSERS.gemini(
      JSON.stringify({
        id: "m3",
        type: "gemini",
        content: [{ text: "First part." }, { functionCall: {} }, { text: "Second part." }],
      }),
      GEMINI_FILE,
    ),
  ).toEqual({ text: "First part.\nSecond part.", conversationId: "a1b2c3d4" });
});

test.each([
  ["a $patch mutation", JSON.stringify({ $patch: { id: "m2", content: "Changed" } })],
  ["a $set mutation", JSON.stringify({ $set: { type: "gemini", content: "x" } })],
  ["a $rewindTo mutation", JSON.stringify({ $rewindTo: "m1" })],
  ["a user message", JSON.stringify({ id: "m1", type: "user", content: "hi" })],
  ["an info message", JSON.stringify({ id: "m4", type: "info", content: "note" })],
  ["empty content", JSON.stringify({ id: "m5", type: "gemini", content: "  " })],
  ["parts without text", JSON.stringify({ id: "m6", type: "gemini", content: [{ x: 1 }] })],
  ["missing content", JSON.stringify({ id: "m7", type: "gemini" })],
  ["garbage", "garbage"],
])("gemini: %s → null", (_name, line) => {
  expect(PARSERS.gemini(line, GEMINI_FILE)).toBeNull();
});

test("lines: each trimmed non-empty line is a message", () => {
  expect(PARSERS.lines("  Build finished.  ", "/tmp/log")).toEqual({ text: "Build finished." });
  expect(PARSERS.lines("   ", "/tmp/log")).toBeNull();
  expect(PARSERS.lines("", "/tmp/log")).toBeNull();
});
