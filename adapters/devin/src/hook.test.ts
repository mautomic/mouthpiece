import { expect, test } from "bun:test";
import type { InterruptRequest, SpeakEvent } from "@mouthpiece/core";
import type { HookContext } from "@mouthpiece/hook-kit";
import { handleHook } from "./hook.ts";

function deps(env: Record<string, string | undefined> = {}) {
  const spoken: SpeakEvent[] = [];
  const interrupts: InterruptRequest[] = [];
  const reads: string[] = [];
  const d: HookContext = {
    speak: async (e) => spoken.push(e),
    interrupt: async (r) => interrupts.push(r),
    readFile: async (p) => {
      reads.push(p);
      return "";
    },
    env,
  };
  return { d, spoken, interrupts, reads };
}

// Payloads captured from a real Devin CLI run (3000.11.92). There is no `cwd`: the project comes
// from the DEVIN_PROJECT_DIR environment variable. `session_id` is a session name.
const ENV = { DEVIN_PROJECT_DIR: "/Users/me/code/projects/api" };
const common = { session_id: "polydactyl-logic", prompt_id: "0b884bc8-5d25-46a0-b1ba" };
const stopInput = {
  ...common,
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Added the **endpoint**.",
};

test("stop speaks last_assistant_message as a devin response labeled from DEVIN_PROJECT_DIR", async () => {
  const { d, spoken } = deps(ENV);
  await handleHook("stop", stopInput, d);
  expect(spoken).toEqual([
    {
      text: "Added the **endpoint**.",
      source: "devin",
      conversationId: "polydactyl-logic",
      label: "api",
      kind: "response",
      format: "markdown",
    },
  ]);
});

test("stop without DEVIN_PROJECT_DIR has no label", async () => {
  const { d, spoken } = deps();
  await handleHook("stop", stopInput, d);
  expect(spoken[0]?.label).toBeUndefined();
});

test.each([[null], [""], ["   "], [undefined], [42]])(
  "stop ignores an unusable last_assistant_message %p and never reads a file",
  async (message) => {
    const { d, spoken, reads } = deps(ENV);
    await handleHook("stop", { ...stopInput, last_assistant_message: message }, d);
    expect(spoken).toEqual([]);
    expect(reads).toEqual([]);
  },
);

test("prompt interrupts only this session", async () => {
  const { d, interrupts, spoken } = deps(ENV);
  await handleHook("prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "hi" }, d);
  expect(interrupts).toEqual([{ source: "devin", conversationId: "polydactyl-logic" }]);
  expect(spoken).toEqual([]);
});

test("prompt without a session id interrupts nothing", async () => {
  const { d, interrupts } = deps(ENV);
  await handleHook("prompt", { hook_event_name: "UserPromptSubmit" }, d);
  expect(interrupts).toEqual([]);
});

test("permission speaks an alert naming the project and tool", async () => {
  const { d, spoken } = deps(ENV);
  await handleHook(
    "permission",
    { ...common, hook_event_name: "PermissionRequest", tool_name: "exec", tool_input: {} },
    d,
  );
  expect(spoken).toEqual([
    {
      text: "api needs your approval to use exec.",
      source: "devin",
      conversationId: "polydactyl-logic",
      kind: "alert",
      format: "plain",
    },
  ]);
});

test("permission without a tool name, and without a project", async () => {
  const withProject = deps(ENV);
  await handleHook(
    "permission",
    { ...common, hook_event_name: "PermissionRequest" },
    withProject.d,
  );
  const without = deps();
  await handleHook("permission", { ...common, hook_event_name: "PermissionRequest" }, without.d);
  expect(withProject.spoken.map((s) => s.text)).toEqual(["api needs your approval."]);
  expect(without.spoken.map((s) => s.text)).toEqual(["Devin needs your approval."]);
});

test("unknown events are ignored", async () => {
  const { d, spoken, interrupts } = deps(ENV);
  await handleHook("session-start", stopInput, d);
  await handleHook("", stopInput, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});

test.each([[null], ["text"], [[]]])("non-object input %p is ignored", async (input) => {
  const { d, spoken, interrupts } = deps(ENV);
  await handleHook("stop", input, d);
  await handleHook("prompt", input, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});

test("MOUTHPIECE_CHILD=1 does nothing", async () => {
  const { d, spoken, interrupts } = deps({ ...ENV, MOUTHPIECE_CHILD: "1" });
  await handleHook("stop", stopInput, d);
  await handleHook("prompt", common, d);
  await handleHook("permission", { ...common, tool_name: "exec" }, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});
