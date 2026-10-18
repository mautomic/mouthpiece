import type { CommandFn } from "../types.ts";
import { pauseReasonCommand } from "./pause.ts";

/** `mouthpiece resume [--reason r]` (US-022): removes one pause reason. */
export const resumeCommand: CommandFn = pauseReasonCommand("resume");
