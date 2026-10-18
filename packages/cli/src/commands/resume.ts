import type { CommandFn } from "../types.ts";

/** `mouthpiece resume [--reason r]` (US-022). Stub until Phase 4 Task 3. */
export const resumeCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: resume is not implemented yet\n");
  return 1;
};
