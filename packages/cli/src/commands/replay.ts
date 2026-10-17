import { parseArgs } from "node:util";
import type { CommandFn } from "../types.ts";

/** `mouthpiece replay [--full]` (US-010). */
export const replayCommand: CommandFn = async (args, io, deps) => {
  const { values } = parseArgs({ args, options: { full: { type: "boolean", default: false } } });
  const { id } = await deps.client.replay({ full: values.full });
  if (!id) {
    io.err("mouthpiece: nothing to replay yet\n");
    return 1;
  }
  io.out(`${JSON.stringify({ id })}\n`);
  return 0;
};
