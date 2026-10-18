import type { CommandFn } from "../types.ts";

/** `mouthpiece pause [--reason r]` (US-022). Stub until Phase 4 Task 3. */
export const pauseCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: pause is not implemented yet\n");
  return 1;
};
