import type { CommandFn } from "../types.ts";

export const modeCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: mode is not implemented yet\n");
  return 1;
};
