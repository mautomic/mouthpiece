import { parseArgs } from "node:util";
import { mergeHooks, updateJsonFile } from "../claude-settings.ts";
import { type HookTarget, hookMainFor, isTargetName, TARGETS } from "../hook-targets.ts";
import type { CliIO, CommandFn } from "../types.ts";

export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

/** Resolves `--target` (default claude-code); prints an error and returns null for an unknown one. */
export function resolveTarget(value: string | undefined, io: CliIO): HookTarget | null {
  const name = value ?? "claude-code";
  if (isTargetName(name)) return TARGETS[name];
  io.err(`mouthpiece: unknown target "${name}" (expected ${Object.keys(TARGETS).join(", ")})\n`);
  return null;
}

export const installHooksCommand: CommandFn = async (args, io, deps) => {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      "idle-alerts": { type: "boolean", default: false },
    },
  });
  const target = resolveTarget(values.target, io);
  if (!target) return 2;
  const path = target.settingsPath(deps.env);
  const spec = {
    bun: deps.paths.bun,
    hookMain: hookMainFor(deps.paths.repoRoot, target),
    idleAlerts: values["idle-alerts"],
  };
  const { backup } = await updateJsonFile(
    path,
    (current) => mergeHooks(current, target, spec),
    stamp(),
  );
  io.out(
    `Installed Mouthpiece hooks into ${path}${backup ? ` (backup: ${backup})` : ""}.\n${target.afterInstall}\n`,
  );
  return 0;
};
