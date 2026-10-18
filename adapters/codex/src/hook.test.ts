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

// Field names from the Codex hooks docs (snake_case payloads).
const common = {
  session_id: "019a-codex-session",
  cwd: "/Users/me/code/projects/api",
  transcript_path: "/Users/me/.codex/sessions/2026/10/17/rollout-x.jsonl",
  model: "gpt-5-codex",
};
const stopInput = {
  ...common,
  hook_event_name: "Stop",
  turn_id: "t1",
  last_assistant_message: "Added the **endpoint**.",
};

test("stop speaks last_assistant_message as a codex response", async () => {
  const { d, spoken } = deps();
  await handleHook("stop", stopInput, d);
  expect(spoken).toEqual([
    {
      text: "Added the **endpoint**.",
      source: "codex",
      conversationId: "019a-codex-session",
      label: "api",
      kind: "response",
      format: "markdown",
    },
  ]);
});

test.each([[null], [""], ["   "], [undefined], [42]])(
  "stop ignores an unusable last_assistant_message %p and never reads the transcript",
  async (message) => {
    const { d, spoken, reads } = deps();
    await handleHook("stop", { ...stopInput, last_assistant_message: message }, d);
    expect(spoken).toEqual([]);
    expect(reads).toEqual([]);
  },
);

test.each([["prompt"], ["interrupt"]])("%s interrupts only this session", async (event) => {
  const { d, interrupts, spoken } = deps();
  await handleHook(
    event,
    { ...common, hook_event_name: event === "prompt" ? "UserPromptSubmit" : "Interrupt" },
    d,
  );
  expect(interrupts).toEqual([{ source: "codex", conversationId: "019a-codex-session" }]);
  expect(spoken).toEqual([]);
});

test("permission speaks an alert naming the project and tool", async () => {
  const { d, spoken } = deps();
  await handleHook(
    "permission",
    {
      ...common,
      hook_event_name: "PermissionRequest",
      tool_name: "shell",
      tool_input: { description: "Run the tests" },
    },
    d,
  );
  expect(spoken).toEqual([
    {
      text: "api needs your approval to use shell.",
      source: "codex",
      conversationId: "019a-codex-session",
      kind: "alert",
      format: "plain",
    },
  ]);
});

test("permission without a tool name, and without a cwd", async () => {
  const { d, spoken } = deps();
  await handleHook("permission", { ...common, hook_event_name: "PermissionRequest" }, d);
  await handleHook("permission", { session_id: "s", hook_event_name: "PermissionRequest" }, d);
  expect(spoken.map((s) => s.text)).toEqual([
    "api needs your approval.",
    "Codex needs your approval.",
  ]);
});

test("unknown events are ignored", async () => {
  const { d, spoken, interrupts } = deps();
  await handleHook("session-start", stopInput, d);
  await handleHook("", stopInput, d);
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
  await handleHook("stop", stopInput, d);
  await handleHook("prompt", common, d);
  await handleHook("permission", { ...common, tool_name: "shell" }, d);
  expect(spoken).toEqual([]);
  expect(interrupts).toEqual([]);
});

const ORCA = { ORCA_TERMINAL_HANDLE: "term_148202cb-9a23-4308-8380-a4efd3957057" };
const orcaRoute = { via: "orca", target: ORCA.ORCA_TERMINAL_HANDLE, agent: "codex" } as const;

test("stop attaches the Orca reply route when Codex runs in Orca", async () => {
  const { d, spoken } = deps(ORCA);
  await handleHook("stop", { session_id: "s1", cwd: "/x/web", last_assistant_message: "Done." }, d);
  expect(spoken[0]?.reply).toEqual(orcaRoute);
});

test("stop outside Orca has no reply field", async () => {
  const { d, spoken } = deps();
  await handleHook("stop", { session_id: "s1", cwd: "/x/web", last_assistant_message: "Done." }, d);
  expect(spoken[0]).not.toHaveProperty("reply");
});

test("a permission alert attaches the route too", async () => {
  const { d, spoken } = deps(ORCA);
  await handleHook("permission", { session_id: "s1", cwd: "/x/web", tool_name: "Bash" }, d);
  expect(spoken[0]?.reply).toEqual(orcaRoute);
});
