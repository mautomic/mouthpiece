import { authCommand } from "./commands/auth.ts";
import { buildHotkeysCommand } from "./commands/build-hotkeys.ts";
import { installAgentCommand } from "./commands/install-agent.ts";
import { installHooksCommand } from "./commands/install-hooks.ts";
import { modeCommand } from "./commands/mode.ts";
import { replayCommand } from "./commands/replay.ts";
import { sayCommand } from "./commands/say.ts";
import { tailCommand } from "./commands/tail.ts";
import { uninstallAgentCommand } from "./commands/uninstall-agent.ts";
import { uninstallHooksCommand } from "./commands/uninstall-hooks.ts";
import { usageCommand } from "./commands/usage.ts";
import { voicesCommand } from "./commands/voices.ts";
import type { CliDeps, CliIO } from "./types.ts";

export type { CliDeps, CliIO } from "./types.ts";

const USAGE = `usage: mouthpiece <command>
  start                                   run the daemon in the foreground
  say [text…] [--file path] [--source s] [--label l] [--kind response|alert|info]
      [--mode summary|full|off] [--voice v] [--priority high|normal|low]
      [--plain | --markdown] [--fallback-say]
                                          speak text (reads stdin when no text or --file is given)
  stop | skip | status
  mode [summary|full|off|toggle|clear] [--source s] [--conversation c]
  replay [--full]
  usage [--month YYYY-MM]
  voices [--provider x]                   list each provider's voices
  tail --format codex|gemini|lines [--path p] [--source s] [--label l]
                                          speak new messages from a session log
  install-hooks [--target claude-code|codex|gemini] [--idle-alerts]
  uninstall-hooks [--target claude-code|codex|gemini]
  install-agent | uninstall-agent
  auth <provider> [--delete]              read the API key from stdin
  build-hotkeys`;

export async function run(argv: string[], io: CliIO, deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "start": {
        const { url } = await deps.startDaemon();
        io.err(`mouthpiece daemon listening on ${url}\n`);
        return 0;
      }
      case "say":
        return await sayCommand(rest, io, deps);
      case "stop":
        io.out(`${JSON.stringify(await deps.client.stop())}\n`);
        return 0;
      case "skip":
        io.out(`${JSON.stringify(await deps.client.skip())}\n`);
        return 0;
      case "status":
        io.out(`${JSON.stringify(await deps.client.health(), null, 2)}\n`);
        return 0;
      case "mode":
        return await modeCommand(rest, io, deps);
      case "replay":
        return await replayCommand(rest, io, deps);
      case "usage":
        return await usageCommand(rest, io, deps);
      case "voices":
        return await voicesCommand(rest, io, deps);
      case "tail":
        return await tailCommand(rest, io, deps);
      case "install-hooks":
        return await installHooksCommand(rest, io, deps);
      case "uninstall-hooks":
        return await uninstallHooksCommand(rest, io, deps);
      case "install-agent":
        return await installAgentCommand(rest, io, deps);
      case "uninstall-agent":
        return await uninstallAgentCommand(rest, io, deps);
      case "auth":
        return await authCommand(rest, io, deps);
      case "build-hotkeys":
        return await buildHotkeysCommand(rest, io, deps);
      default:
        io.err(`${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    io.err(`mouthpiece: ${(error as Error).message}\n`);
    return 1;
  }
}
