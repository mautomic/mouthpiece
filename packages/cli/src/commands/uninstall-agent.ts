import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_LABEL, launchAgentsDir } from "../launchd.ts";
import type { CommandFn } from "../types.ts";

export const uninstallAgentCommand: CommandFn = async (_args, io, deps) => {
  // A non-zero bootout just means the agent was not loaded.
  await deps.exec(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${AGENT_LABEL}`]);
  await rm(join(launchAgentsDir(deps.env), `${AGENT_LABEL}.plist`), { force: true });
  io.out(`Removed launchd agent ${AGENT_LABEL}.\n`);
  return 0;
};
