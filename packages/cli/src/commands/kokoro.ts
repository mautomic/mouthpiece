import type { CommandFn } from "../types.ts";

/** `mouthpiece kokoro install | status | uninstall` (US-019). Stub until Phase 4 Task 2. */
export const kokoroCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: kokoro is not implemented yet\n");
  return 1;
};
