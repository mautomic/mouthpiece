import { expect, test } from "bun:test";
import type { InterruptRequest, SpeakEvent } from "@mouthpiece/core";
import type { HookContext } from "@mouthpiece/hook-kit";
import { handleHook } from "./hook.ts";

function deps(env: Record<string, string | undefined> = {}) {
  const spoken: SpeakEvent[] = [];
  const interrupts: InterruptRequest[] = [];
  const d: HookContext = {
    speak: async (e) => spoken.push(e),
    interrupt: async (r) => interrupts.push(r),
    readFile: async () => "",
    env,
  };
  return { d, spoken, interrupts };
}

// Field names from the Gemini CLI hook source (v0.64.0).
const common = {
  session_id: "gem-session-1",
  cwd: "/Users/me/code/projects/site",
  transcript_path: "/Users/me/.gemini/tmp/site/chats/session-1.jsonl",
  timestamp: "2026-10-17T12:00:00.000Z",
};
const afterAgent = {
  ...common,
  hook_event_name: "AfterAgent",
  prompt: "fix it",
  prompt_response: "Fixed the *layout*.",
};

test("stop speaks prompt_response as a gemini response", async () => {
  const { d, spoken } = deps();
  await handleHook("stop", afterAgent, d);
  expect(spoken).toEqual([
    {
      text: "Fixed the *layout*.",
      source: "gemini",
      conversationId: "gem-session-1",
      label: "site",
      kind: "response",
      format: "markdown",
    },
  ]);
});

test.each([[null], [""], ["  \n "], [undefined], [{}]])(
  "stop ignores an unusable prompt_response %p",
  async (response) => {
    const { d, spoken } = deps();
    await handleHook("stop", { ...afterAgent, prompt_response: response }, d);
    expect(spoken).toEqual([]);
  },
);

test("prompt interrupts only this session", async () => {
  const { d, interrupts } = deps();
  await handleHook("prompt", { ...common, hook_event_name: "BeforeAgent", prompt: "next" }, d);
  expect(interrupts).toEqual([{ source: "gemini", conversationId: "gem-session-1" }]);
});

const notification = {
  ...common,
  hook_event_name: "Notification",
  notification_type: "ToolPermission",
  message: "Tool requires confirmation",
};

test("a ToolPermission notification speaks an alert naming the tool", async () => {
  const { d, spoken } = deps();
  await handleHook("notify", { ...notification, details: { toolName: "run_shell_command" } }, d);
  await handleHook("notify", { ...notification, details: { name: "write_file" } }, d);
  expect(spoken).toEqual([
    {
      text: "site needs your approval to use run_shell_command.",
      source: "gemini",
      conversationId: "gem-session-1",
      kind: "alert",
      format: "plain",
    },
    {
      text: "site needs your approval to use write_file.",
      source: "gemini",
      conversationId: "gem-session-1",
      kind: "alert",
      format: "plain",
    },
  ]);
});

test("a ToolPermission notification without a tool name, and without a cwd", async () => {
  const { d, spoken } = deps();
  await handleHook("notify", { ...notification, details: { title: "Confirm" } }, d);
  await handleHook(
    "notify",
    { session_id: "s", notification_type: "ToolPermission", details: { toolName: 7 } },
    d,
  );
  expect(spoken.map((s) => s.text)).toEqual([
    "site needs your approval.",
    "Gemini needs your approval.",
  ]);
});

test("other notification types are ignored", async () => {
  const { d, spoken } = deps();
  await handleHook("notify", { ...notification, notification_type: "Other" }, d);
  await handleHook("notify", { ...common }, d);
  expect(spoken).toEqual([]);
});

test("unknown events are ignored", async () => {
  const { d, spoken, interrupts } = deps();
  await handleHook("before-tool", afterAgent, d);
  await handleHook("", afterAgent, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});

test.each([[null], ["text"], [[]]])("non-object input %p is ignored", async (input) => {
  const { d, spoken, interrupts } = deps();
  await handleHook("stop", input, d);
  await handleHook("prompt", input, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});

test("MOUTHPIECE_CHILD=1 does nothing", async () => {
  const { d, spoken, interrupts } = deps({ MOUTHPIECE_CHILD: "1" });
  await handleHook("stop", afterAgent, d);
  await handleHook("prompt", common, d);
  await handleHook("notify", notification, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});
