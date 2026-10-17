// hook-targets.ts: where each hook-capable tool keeps its hooks, and the entries Mouthpiece adds
// (US-011, US-014). All three tools share the {Event: [{matcher?, hooks: [...]}]} shape.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "@mouthpiece/core";

export interface HookSpec {
  bun: string;
  hookMain: string;
  idleAlerts: boolean;
}

export type Group = Record<string, unknown> & { hooks: unknown[] };

export interface HookTarget {
  name: "claude-code" | "codex" | "gemini";
  settingsPath(env: Env): string;
  /** Our entries are recognized by this path in their command. */
  marker: string;
  groups(spec: HookSpec): Record<string, Group[]>;
  /** What the user must do (or know) after installing. */
  afterInstall: string;
}

export type TargetName = HookTarget["name"];

function markerFor(name: TargetName): string {
  return `/adapters/${name}/src/main.ts`;
}

/** `"<bun>" "<hookMain>" <arg>`, the same for every target. */
function commandLine(spec: HookSpec, arg: string): string {
  return `${JSON.stringify(spec.bun)} ${JSON.stringify(spec.hookMain)} ${arg}`;
}

export function claudeSettingsPath(env: Env): string {
  return (
    env.MOUTHPIECE_CLAUDE_SETTINGS ||
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json")
  );
}

const claudeCode: HookTarget = {
  name: "claude-code",
  settingsPath: claudeSettingsPath,
  marker: markerFor("claude-code"),
  groups(spec) {
    const hook = (arg: string) => ({
      type: "command",
      command: commandLine(spec, arg),
      async: true,
    });
    return {
      Stop: [{ hooks: [hook("stop")] }],
      UserPromptSubmit: [{ hooks: [hook("prompt")] }],
      Notification: [
        {
          matcher: spec.idleAlerts ? "permission_prompt|idle_prompt" : "permission_prompt",
          hooks: [hook("notify")],
        },
      ],
    };
  },
  afterInstall: "New Claude Code sessions will speak.",
};

/** Codex: `$CODEX_HOME/hooks.json`, timeouts in seconds. Never touches config.toml. */
const codex: HookTarget = {
  name: "codex",
  settingsPath: (env) =>
    env.MOUTHPIECE_CODEX_HOOKS || join(env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json"),
  marker: markerFor("codex"),
  groups(spec) {
    const hook = (arg: string, timeout: number, async: boolean) => ({
      type: "command",
      command: commandLine(spec, arg),
      ...(async ? { async: true } : {}),
      timeout,
    });
    return {
      Stop: [{ hooks: [hook("stop", 10, true)] }],
      UserPromptSubmit: [{ hooks: [hook("prompt", 5, false)] }],
      Interrupt: [{ hooks: [hook("interrupt", 5, true)] }],
      PermissionRequest: [{ hooks: [hook("permission", 5, true)] }],
    };
  },
  afterInstall:
    "Open Codex and run /hooks to trust the Mouthpiece hooks (they won't run until trusted).",
};

/** Gemini CLI: `$GEMINI_HOME/settings.json`, named entries, timeouts in milliseconds, no async. */
const gemini: HookTarget = {
  name: "gemini",
  settingsPath: (env) =>
    env.MOUTHPIECE_GEMINI_SETTINGS ||
    join(env.GEMINI_HOME || join(homedir(), ".gemini"), "settings.json"),
  marker: markerFor("gemini"),
  groups(spec) {
    const hook = (name: string, arg: string) => ({
      name,
      type: "command",
      command: commandLine(spec, arg),
      timeout: 2000,
    });
    return {
      AfterAgent: [{ hooks: [hook("mouthpiece-speak", "stop")] }],
      BeforeAgent: [{ hooks: [hook("mouthpiece-interrupt", "prompt")] }],
      Notification: [{ hooks: [hook("mouthpiece-notify", "notify")] }],
    };
  },
  afterInstall: "Gemini CLI hooks are enabled by default; manage them with /hooks panel.",
};

export const TARGETS: Record<TargetName, HookTarget> = {
  "claude-code": claudeCode,
  codex,
  gemini,
};

export function isTargetName(name: string): name is TargetName {
  return Object.hasOwn(TARGETS, name);
}

/** `<repoRoot>/adapters/<name>/src/main.ts`. */
export function hookMainFor(repoRoot: string, target: HookTarget | TargetName): string {
  const name = typeof target === "string" ? target : target.name;
  return join(repoRoot, markerFor(name));
}
