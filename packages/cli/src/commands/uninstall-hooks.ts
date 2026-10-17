import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { removeHooks, updateJsonFile } from "../claude-settings.ts";
import type { CommandFn } from "../types.ts";
import { resolveTarget, stamp } from "./install-hooks.ts";

export const uninstallHooksCommand: CommandFn = async (args, io, deps) => {
  const { values } = parseArgs({ args, options: { target: { type: "string" } } });
  const target = resolveTarget(values.target, io);
  if (!target) return 2;
  const path = target.settingsPath(deps.env);
  const current = await readFile(path, "utf8").then(JSON.parse, () => undefined);
  if (removeHooks(current, target).removed === 0) {
    io.out("No Mouthpiece hooks found.\n");
    return 0;
  }
  await updateJsonFile(path, (c) => removeHooks(c, target).settings, stamp());
  io.out(`Removed Mouthpiece hooks from ${path}.\n`);
  return 0;
};
