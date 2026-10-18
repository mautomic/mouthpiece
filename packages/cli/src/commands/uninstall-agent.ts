import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_LABEL, guiDomain, launchAgentsDir } from "../launchd.ts";
import type { CommandFn } from "../types.ts";

export const uninstallAgentCommand: CommandFn = async (_args, io, deps) => {
  // A non-zero bootout just means the agent was not loaded.
  await deps.exec(["launchctl", "bootout", `${guiDomain()}/${AGENT_LABEL}`]);
  await rm(join(launchAgentsDir(deps.env), `${AGENT_LABEL}.plist`), { force: true });
  io.out(`Removed launchd agent ${AGENT_LABEL}.\n`);
  return 0;
};
