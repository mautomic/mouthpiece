import { parseArgs } from "node:util";
import { DEFAULT_PAUSE_REASON } from "@mouthpiece/core";
import type { CommandFn } from "../types.ts";

/** `mouthpiece pause|resume [--reason r]`: the daemon validates the reason (US-022). */
export function pauseReasonCommand(action: "pause" | "resume"): CommandFn {
  return async (args, io, deps) => {
    const { values } = parseArgs({ args, options: { reason: { type: "string" } } });
    const reason = values.reason ?? DEFAULT_PAUSE_REASON;
    const result = await deps.client[action](reason);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  };
}

/** `mouthpiece pause [--reason r]` (US-022): speech stays paused until every reason is resumed. */
export const pauseCommand: CommandFn = pauseReasonCommand("pause");
