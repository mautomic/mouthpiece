import type { CommandFn } from "../types.ts";

/** `mouthpiece send --tmux <target> <text…>` (PRD §12 spike). Stub until Phase 4 Task 5. */
export const sendCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: send is not implemented yet\n");
  return 1;
};
