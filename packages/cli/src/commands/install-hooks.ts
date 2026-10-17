import type { CommandFn } from "../types.ts";

export const installHooksCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: install-hooks is not implemented yet\n");
  return 1;
};
