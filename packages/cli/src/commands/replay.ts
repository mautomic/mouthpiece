import type { CommandFn } from "../types.ts";

export const replayCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: replay is not implemented yet\n");
  return 1;
};
