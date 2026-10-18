import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mouthpieceHome } from "@mouthpiece/core";
import { AGENT_LABEL, agentPlist, guiDomain, launchAgentsDir } from "../launchd.ts";
import type { CommandFn } from "../types.ts";

const PASSTHROUGH_ENV = ["MOUTHPIECE_HOME", "MOUTHPIECE_CONFIG", "MOUTHPIECE_PORT"] as const;

export const installAgentCommand: CommandFn = async (_args, io, deps) => {
  const home = mouthpieceHome(deps.env);
  const which = await deps.exec(["/usr/bin/which", "claude"]);
  const claudeDir = which.code === 0 && which.stdout.trim() ? [dirname(which.stdout.trim())] : [];
  const pathDirs = [
    ...new Set([dirname(deps.paths.bun), ...claudeDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
  ];
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = deps.env[key];
    if (value) env[key] = value;
  }
  const dir = launchAgentsDir(deps.env);
  const plistPath = join(dir, `${AGENT_LABEL}.plist`);
  await mkdir(dir, { recursive: true });
  await mkdir(home, { recursive: true });
  const logPath = join(home, "daemon.log");
  await writeFile(
    plistPath,
    agentPlist({
      bun: deps.paths.bun,
      cliMain: join(deps.paths.repoRoot, "packages/cli/src/main.ts"),
      logPath,
      pathDirs,
      env,
    }),
  );
  const domain = guiDomain();
  await deps.exec(["launchctl", "bootout", `${domain}/${AGENT_LABEL}`]); // not loaded yet is fine
  const boot = await deps.exec(["launchctl", "bootstrap", domain, plistPath]);
  if (boot.code !== 0) {
    io.err(`mouthpiece: launchctl bootstrap failed: ${boot.stderr.trim()}\n`);
    return 1;
  }
  io.out(`Daemon installed as launchd agent ${AGENT_LABEL} (starts at login). Logs: ${logPath}\n`);
  if (claudeDir.length === 0) {
    io.err("warning: `claude` not found on PATH; summaries will fall back to first sentences.\n");
  }
  return 0;
};
