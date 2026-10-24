import { parseArgs } from "node:util";
import { MODES, type Mode, type ModeRequest } from "@mouthpiece/core";
import type { CommandFn } from "../types.ts";

/** `mouthpiece mode [summary|summary-short|full|off|toggle|clear] [--source s] [--conversation c]` (US-010). */
export const modeCommand: CommandFn = async (args, io, deps) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { source: { type: "string" }, conversation: { type: "string" } },
  });
  const [action] = positionals;
  if (action === undefined) {
    io.out(`${JSON.stringify(await deps.client.getMode(), null, 2)}\n`);
    return 0;
  }
  const scope: Pick<ModeRequest, "source" | "conversationId"> = {
    ...(values.source !== undefined ? { source: values.source } : {}),
    ...(values.conversation !== undefined ? { conversationId: values.conversation } : {}),
  };
  let req: ModeRequest;
  if (action === "toggle") req = { toggle: true, ...scope };
  else if (action === "clear") req = { clear: true, ...scope };
  else if ((MODES as readonly string[]).includes(action)) req = { mode: action as Mode, ...scope };
  else {
    io.err(`mouthpiece: mode must be one of ${MODES.join(", ")}, toggle, clear\n`);
    return 2;
  }
  io.out(`${JSON.stringify(await deps.client.setMode(req), null, 2)}\n`);
  return 0;
};
