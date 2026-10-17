import type { CommandFn } from "../types.ts";

export const uninstallHooksCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: uninstall-hooks is not implemented yet\n");
  return 1;
};
