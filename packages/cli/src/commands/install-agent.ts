import type { CommandFn } from "../types.ts";

export const installAgentCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: install-agent is not implemented yet\n");
  return 1;
};
