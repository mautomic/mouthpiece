import type { CommandFn } from "../types.ts";

/** `mouthpiece voices [--provider x]` (US-015). Stub until Phase 3 Task 9. */
export const voicesCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: voices is not implemented yet\n");
  return 1;
};
