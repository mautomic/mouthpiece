import type { CommandFn } from "../types.ts";

export const usageCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: usage is not implemented yet\n");
  return 1;
};
