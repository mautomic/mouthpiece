import { readFile } from "node:fs/promises";
import { claudeSettingsPath, removeHooks, updateJsonFile } from "../claude-settings.ts";
import type { CommandFn } from "../types.ts";
import { stamp } from "./install-hooks.ts";

export const uninstallHooksCommand: CommandFn = async (_args, io, deps) => {
  const path = claudeSettingsPath(deps.env);
  const current = await readFile(path, "utf8").then(JSON.parse, () => undefined);
  if (removeHooks(current).removed === 0) {
    io.out("No Mouthpiece hooks found.\n");
    return 0;
  }
  await updateJsonFile(path, (c) => removeHooks(c).settings, stamp());
  io.out(`Removed Mouthpiece hooks from ${path}.\n`);
  return 0;
};
