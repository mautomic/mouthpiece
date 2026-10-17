import type { CommandFn } from "../types.ts";

/** `mouthpiece tail --format codex|gemini|lines …` (US-014). Stub until Phase 3 Task 8. */
export const tailCommand: CommandFn = async (_args, io) => {
  io.err("mouthpiece: tail is not implemented yet\n");
  return 1;
};
