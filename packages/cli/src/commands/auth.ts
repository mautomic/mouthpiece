import type { CommandFn } from "../types.ts";

export const authCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: auth is not implemented yet\n");
  return 1;
};
