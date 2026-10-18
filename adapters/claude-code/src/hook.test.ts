import { expect, test } from "bun:test";
import type { InterruptRequest, SpeakEvent } from "@mouthpiece/core";
import { type HookDeps, handleHook, lastAssistantTextFromTranscript } from "./hook.ts";

function deps(env: Record<string, string | undefined> = {}, files: Record<string, string> = {}) {
  const spoken: SpeakEvent[] = [];
  const interrupts: InterruptRequest[] = [];
  const d: HookDeps = {
    speak: async (e) => spoken.push(e),
    interrupt: async (r) => interrupts.push(r),
    readFile: async (p) => {
      const content = files[p];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    env,
  };
  return { d, spoken, interrupts };
}

const stopInput = {
  session_id: "s1",
  cwd: "/Users/me/code/projects/web",
  last_assistant_message: "Refactor **done**.",
};

test("stop speaks the last assistant message as a claude-code response", async () => {
  const { d, spoken } = deps();
  await handleHook("stop", stopInput, d);
  expect(spoken).toEqual([
    {
      text: "Refactor **done**.",
      source: "claude-code",
      conversationId: "s1",
      label: "web",
      kind: "response",
      format: "markdown",
    },
  ]);
});

test("stop falls back to the transcript when the field is missing", async () => {
  const transcript = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "From transcript." }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }),
  ].join("\n");
  const { d, spoken } = deps({}, { "/t.jsonl": transcript });
  await handleHook("stop", { session_id: "s1", transcript_path: "/t.jsonl" }, d);
  expect(spoken[0]?.text).toBe("From transcript.");
});

test("prompt interrupts only this session", async () => {
  const { d, interrupts } = deps();
  await handleHook("prompt", { session_id: "s1", prompt: "next" }, d);
  expect(interrupts).toEqual([{ source: "claude-code", conversationId: "s1" }]);
});

test("MOUTHPIECE_CHILD=1 does nothing", async () => {
  const { d, spoken, interrupts } = deps({ MOUTHPIECE_CHILD: "1" });
  await handleHook("stop", stopInput, d);
  await handleHook("prompt", { session_id: "s1" }, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});

test.each([[null], ["text"], [{}], [{ last_assistant_message: "   " }]])(
  "ignores unusable input %p",
  async (input) => {
    const { d, spoken } = deps();
    await handleHook("stop", input, d);
    expect(spoken).toEqual([]);
  },
);

test("unknown events are ignored", async () => {
  const { d, spoken } = deps();
  await handleHook("subagent-stop", stopInput, d);
  expect(spoken).toEqual([]);
});

test("permission_prompt speaks an alert naming the project and tool", async () => {
  const { d, spoken } = deps();
  await handleHook(
    "notify",
    {
      session_id: "s1",
      cwd: "/x/web",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    },
    d,
  );
  expect(spoken).toEqual([
    {
      text: "web needs your approval to use Bash.",
      source: "claude-code",
      conversationId: "s1",
      kind: "alert",
      format: "plain",
    },
  ]);
});

test("permission_prompt without a recognizable tool, and idle_prompt", async () => {
  const { d, spoken } = deps();
  await handleHook(
    "notify",
    { session_id: "s1", cwd: "/x/web", notification_type: "permission_prompt", message: "?" },
    d,
  );
  await handleHook("notify", { session_id: "s1", notification_type: "idle_prompt" }, d);
  expect(spoken.map((s) => s.text)).toEqual([
    "web needs your approval.",
    "Claude Code is waiting for you.",
  ]);
});

test("unknown notification types are ignored", async () => {
  const { d, spoken } = deps();
  await handleHook("notify", { session_id: "s1", notification_type: "auth_success" }, d);
  expect(spoken).toEqual([]);
});

test("lastAssistantTextFromTranscript skips garbage and tool-only records", () => {
  expect(lastAssistantTextFromTranscript("not json\n\n")).toBeNull();
  const jsonl = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      },
    }),
    "{broken",
  ].join("\n");
  expect(lastAssistantTextFromTranscript(jsonl)).toBe("A\nB");
});
