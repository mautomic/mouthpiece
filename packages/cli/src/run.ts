import { authCommand } from "./commands/auth.ts";
import { buildHotkeysCommand } from "./commands/build-hotkeys.ts";
import { installAgentCommand } from "./commands/install-agent.ts";
import { installHooksCommand } from "./commands/install-hooks.ts";
import { kokoroCommand } from "./commands/kokoro.ts";
import { modeCommand } from "./commands/mode.ts";
import { pauseCommand } from "./commands/pause.ts";
import { replayCommand } from "./commands/replay.ts";
import { resumeCommand } from "./commands/resume.ts";
import { sayCommand } from "./commands/say.ts";
import { sendCommand } from "./commands/send.ts";
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
  pause | resume [--reason r]             pause speech until resumed (default reason: user)
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
  kokoro install | status | uninstall     manage the free local Kokoro voice
  send --tmux <target> <text…>            type text into a tmux pane (conversation spike)
  build-hotkeys | build-helper            build the helper app (hotkeys, menubar, mic pause)`;

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
      case "pause":
        return await pauseCommand(rest, io, deps);
      case "resume":
        return await resumeCommand(rest, io, deps);
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
      case "kokoro":
        return await kokoroCommand(rest, io, deps);
      case "send":
        return await sendCommand(rest, io, deps);
      case "build-hotkeys":
      case "build-helper":
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
