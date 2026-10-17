import type { CommandFn } from "../types.ts";

export const buildHotkeysCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: build-hotkeys is not implemented yet\n");
  return 1;
};
