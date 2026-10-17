import { join } from "node:path";
import { parseArgs } from "node:util";
import { claudeSettingsPath, mergeHooks, updateJsonFile } from "../claude-settings.ts";
import type { CommandFn } from "../types.ts";

export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

export const installHooksCommand: CommandFn = async (args, io, deps) => {
  const { values } = parseArgs({
    args,
    options: { "idle-alerts": { type: "boolean", default: false } },
  });
  const path = claudeSettingsPath(deps.env);
  const spec = {
    bun: deps.paths.bun,
    hookMain: join(deps.paths.repoRoot, "adapters/claude-code/src/main.ts"),
    idleAlerts: values["idle-alerts"],
  };
  const { backup } = await updateJsonFile(path, (current) => mergeHooks(current, spec), stamp());
  io.out(
    `Installed Mouthpiece hooks into ${path}${backup ? ` (backup: ${backup})` : ""}.\nNew Claude Code sessions will speak.\n`,
  );
  return 0;
};
