import type { CommandFn } from "../types.ts";

export const uninstallAgentCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: uninstall-agent is not implemented yet\n");
  return 1;
};
