import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Env, isRecord } from "@mouthpiece/core";

/** Our hook entries are recognized by this path in their command. */
export const HOOK_MARKER = "/adapters/claude-code/src/main.ts";

export interface HookSpec {
  bun: string;
  hookMain: string;
  idleAlerts: boolean;
}

type Group = Record<string, unknown> & { hooks: unknown[] };

const isOurs = (hook: unknown) =>
  isRecord(hook) && typeof hook.command === "string" && hook.command.includes(HOOK_MARKER);

function asObject(settings: unknown): Record<string, unknown> {
  if (settings === undefined) return {};
  if (!isRecord(settings)) throw new Error("settings.json must be a JSON object");
  return structuredClone(settings);
}

function ourGroups(spec: HookSpec): Record<string, Group[]> {
  const command = (event: string) => ({
    type: "command",
    command: `${JSON.stringify(spec.bun)} ${JSON.stringify(spec.hookMain)} ${event}`,
    async: true,
  });
  return {
    Stop: [{ hooks: [command("stop")] }],
    UserPromptSubmit: [{ hooks: [command("prompt")] }],
    Notification: [
      {
        matcher: spec.idleAlerts ? "permission_prompt|idle_prompt" : "permission_prompt",
        hooks: [command("notify")],
      },
    ],
  };
}

export function removeHooks(settings: unknown): {
  settings: Record<string, unknown>;
  removed: number;
} {
  const out = asObject(settings);
  let removed = 0;
  if (!isRecord(out.hooks)) return { settings: out, removed };
  const hooks = out.hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const remaining = group.hooks.filter((hook) => {
        if (!isOurs(hook)) return true;
        removed++;
        return false;
      });
      if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}

export function mergeHooks(settings: unknown, spec: HookSpec): Record<string, unknown> {
  const { settings: clean } = removeHooks(settings);
  const hooks: Record<string, unknown> = isRecord(clean.hooks) ? clean.hooks : {};
  for (const [event, groups] of Object.entries(ourGroups(spec))) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, ...groups];
  }
  return { ...clean, hooks };
}

export function claudeSettingsPath(env: Env): string {
  return (
    env.MOUTHPIECE_CLAUDE_SETTINGS ||
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json")
  );
}

/**
 * Read-modify-write with a backup and an atomic rename. Invalid JSON throws before anything is written.
 * A symlinked path is written through to its target, and the file's mode is kept (0600 for a new file),
 * since settings can hold secrets.
 */
export async function updateJsonFile(
  path: string,
  update: (current: unknown) => unknown,
  stamp: string,
): Promise<{ backup: string | null }> {
  const target = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return path;
    throw error;
  });
  let text: string | null = null;
  let mode = 0o600;
  try {
    text = await readFile(target, "utf8");
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = update(text === null ? undefined : JSON.parse(text));
  let backup: string | null = null;
  if (text !== null) {
    backup = `${path}.bak-mouthpiece-${stamp}`;
    await writeFile(backup, text, { mode });
    await chmod(backup, mode);
  }
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  await chmod(tmp, mode);
  await rename(tmp, target);
  return { backup };
}
