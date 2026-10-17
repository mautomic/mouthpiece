import { expect, test } from "bun:test";
import { mergeHooks, removeHooks } from "./claude-settings.ts";
import { hookMainFor, isTargetName, TARGETS } from "./hook-targets.ts";

const BUN = "/u/.bun/bin/bun";
const specFor = (name: keyof typeof TARGETS, idleAlerts = false) => ({
  bun: BUN,
  hookMain: hookMainFor("/repo", name),
  idleAlerts,
});
const cmd = (name: string, arg: string) => `"${BUN}" "/repo/adapters/${name}/src/main.ts" ${arg}`;

test("hookMainFor points at the adapter's main.ts", () => {
  expect(hookMainFor("/repo", "codex")).toBe("/repo/adapters/codex/src/main.ts");
  expect(hookMainFor("/repo", TARGETS.gemini)).toBe("/repo/adapters/gemini/src/main.ts");
  expect(hookMainFor("/repo", "claude-code")).toBe("/repo/adapters/claude-code/src/main.ts");
});

test("each target's marker is its adapter's main.ts", () => {
  for (const name of ["claude-code", "codex", "gemini"] as const) {
    expect(TARGETS[name].name).toBe(name);
    expect(TARGETS[name].marker).toBe(`/adapters/${name}/src/main.ts`);
  }
});

test("isTargetName accepts only known targets", () => {
  expect(isTargetName("codex")).toBe(true);
  expect(isTargetName("gemini")).toBe(true);
  expect(isTargetName("claude-code")).toBe(true);
  expect(isTargetName("nope")).toBe(false);
  expect(isTargetName("toString")).toBe(false);
});

test("claude-code path precedence is unchanged", () => {
  const p = TARGETS["claude-code"].settingsPath;
  expect(p({ MOUTHPIECE_CLAUDE_SETTINGS: "/x.json", CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/x.json");
  expect(p({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/settings.json");
  expect(p({})).toEndWith("/.claude/settings.json");
});

test("codex path precedence", () => {
  const p = TARGETS.codex.settingsPath;
  expect(p({ MOUTHPIECE_CODEX_HOOKS: "/t/hooks.json", CODEX_HOME: "/ch" })).toBe("/t/hooks.json");
  expect(p({ CODEX_HOME: "/ch" })).toBe("/ch/hooks.json");
  expect(p({})).toEndWith("/.codex/hooks.json");
});

test("gemini path precedence", () => {
  const p = TARGETS.gemini.settingsPath;
  expect(p({ MOUTHPIECE_GEMINI_SETTINGS: "/t/s.json", GEMINI_HOME: "/gh" })).toBe("/t/s.json");
  expect(p({ GEMINI_HOME: "/gh" })).toBe("/gh/settings.json");
  expect(p({})).toEndWith("/.gemini/settings.json");
});

test("claude-code groups", () => {
  const c = (arg: string) => ({ type: "command", command: cmd("claude-code", arg), async: true });
  expect(TARGETS["claude-code"].groups(specFor("claude-code"))).toEqual({
    Stop: [{ hooks: [c("stop")] }],
    UserPromptSubmit: [{ hooks: [c("prompt")] }],
    Notification: [{ matcher: "permission_prompt", hooks: [c("notify")] }],
  });
  expect(
    TARGETS["claude-code"].groups(specFor("claude-code", true)).Notification?.[0]?.matcher,
  ).toBe("permission_prompt|idle_prompt");
});

test("codex groups", () => {
  expect(TARGETS.codex.groups(specFor("codex"))).toEqual({
    Stop: [
      { hooks: [{ type: "command", command: cmd("codex", "stop"), async: true, timeout: 10 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: cmd("codex", "prompt"), timeout: 5 }] },
    ],
    Interrupt: [
      { hooks: [{ type: "command", command: cmd("codex", "interrupt"), async: true, timeout: 5 }] },
    ],
    PermissionRequest: [
      {
        hooks: [{ type: "command", command: cmd("codex", "permission"), async: true, timeout: 5 }],
      },
    ],
  });
  expect(TARGETS.codex.afterInstall).toBe(
    "Open Codex and run /hooks to trust the Mouthpiece hooks (they won't run until trusted).",
  );
});

test("gemini groups", () => {
  const g = (name: string, arg: string) => ({
    name,
    type: "command",
    command: cmd("gemini", arg),
    timeout: 2000,
  });
  expect(TARGETS.gemini.groups(specFor("gemini"))).toEqual({
    AfterAgent: [{ hooks: [g("mouthpiece-speak", "stop")] }],
    BeforeAgent: [{ hooks: [g("mouthpiece-interrupt", "prompt")] }],
    Notification: [{ hooks: [g("mouthpiece-notify", "notify")] }],
  });
  expect(TARGETS.gemini.afterInstall).toBe(
    "Gemini CLI hooks are enabled by default; manage them with /hooks panel.",
  );
});

const foreignStop = { type: "command", command: "/usr/local/bin/notify-me", timeout: 3 };

test("codex: preserves a foreign Stop hook, is idempotent, and removes only ours", () => {
  const original = { hooks: { Stop: [{ hooks: [foreignStop] }] } };
  const once = mergeHooks(original, TARGETS.codex, specFor("codex"));
  const twice = mergeHooks(once, TARGETS.codex, specFor("codex"));
  expect(twice).toEqual(once);
  const hooks = (once as { hooks: Record<string, { hooks: unknown[] }[]> }).hooks;
  expect(Object.keys(hooks).sort()).toEqual([
    "Interrupt",
    "PermissionRequest",
    "Stop",
    "UserPromptSubmit",
  ]);
  expect(hooks.Stop).toHaveLength(2);
  expect(hooks.Stop?.[0]?.hooks).toEqual([foreignStop]);
  const { settings, removed } = removeHooks(once, TARGETS.codex);
  expect(removed).toBe(4);
  expect(settings).toEqual(original);
});

test("gemini: preserves unrelated keys and foreign hooks; removes only ours", () => {
  const original = {
    theme: "GitHub",
    mcpServers: { files: { command: "mcp-files", args: ["--root", "."] } },
    hooks: { AfterAgent: [{ hooks: [{ name: "mine", type: "command", command: "/bin/true" }] }] },
  };
  const merged = mergeHooks(original, TARGETS.gemini, specFor("gemini")) as typeof original;
  expect(merged.theme).toBe("GitHub");
  expect(merged.mcpServers).toEqual(original.mcpServers);
  expect(merged.hooks.AfterAgent).toHaveLength(2);
  expect(mergeHooks(merged, TARGETS.gemini, specFor("gemini"))).toEqual(merged);
  const { settings, removed } = removeHooks(merged, TARGETS.gemini);
  expect(removed).toBe(3);
  expect(settings).toEqual(original);
});

test("targets never remove each other's hooks", () => {
  let s: unknown = {};
  for (const name of ["claude-code", "codex", "gemini"] as const)
    s = mergeHooks(s, TARGETS[name], specFor(name));
  expect(removeHooks(s, TARGETS.codex).removed).toBe(4);
  const withoutCodex = removeHooks(s, TARGETS.codex).settings;
  expect(removeHooks(withoutCodex, TARGETS["claude-code"]).removed).toBe(3);
  expect(removeHooks(withoutCodex, TARGETS.gemini).removed).toBe(3);
});

test("the two-argument forms still default to claude-code", () => {
  const merged = mergeHooks(undefined, specFor("claude-code"));
  expect(merged).toEqual(mergeHooks(undefined, TARGETS["claude-code"], specFor("claude-code")));
  expect(removeHooks(merged).removed).toBe(3);
});
