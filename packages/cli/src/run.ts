import { parseArgs } from "node:util";
import { KINDS, type Kind, type SpeakEvent } from "@mouthpiece/core";
import { authCommand } from "./commands/auth.ts";
import { buildHotkeysCommand } from "./commands/build-hotkeys.ts";
import { installAgentCommand } from "./commands/install-agent.ts";
import { installHooksCommand } from "./commands/install-hooks.ts";
import { modeCommand } from "./commands/mode.ts";
import { replayCommand } from "./commands/replay.ts";
import { uninstallAgentCommand } from "./commands/uninstall-agent.ts";
import { uninstallHooksCommand } from "./commands/uninstall-hooks.ts";
import { usageCommand } from "./commands/usage.ts";
import type { CliDeps, CliIO } from "./types.ts";

export type { CliDeps, CliIO } from "./types.ts";

const USAGE = `usage: mouthpiece <command>
  start                                   run the daemon in the foreground
  say [text…] [--source s] [--label l] [--kind response|alert|info] [--plain]
                                          speak text (reads stdin when no text is given)
  stop | skip | status
  mode [summary|full|off|toggle|clear] [--source s] [--conversation c]
  replay [--full]
  usage [--month YYYY-MM]
  install-hooks [--idle-alerts] | uninstall-hooks
  install-agent | uninstall-agent
  auth <provider> [--delete]          (key on stdin)
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
        return await say(rest, io, deps);
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

async function say(args: string[], io: CliIO, deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: "string", default: "cli" },
      label: { type: "string" },
      kind: { type: "string", default: "response" },
      plain: { type: "boolean", default: false },
    },
  });
  if (!KINDS.includes(values.kind as Kind)) {
    io.err(`mouthpiece: --kind must be one of ${KINDS.join(", ")}\n`);
    return 2;
  }
  const text = (await readText(positionals, io)).trim();
  if (!text) {
    io.err("mouthpiece: nothing to say (pass text or pipe it in)\n");
    return 2;
  }
  const event: SpeakEvent = {
    text,
    source: values.source,
    ...(values.label ? { label: values.label } : {}),
    kind: values.kind as Kind,
    format: values.plain ? "plain" : "markdown",
  };
  io.out(`${JSON.stringify(await deps.client.speak(event))}\n`);
  return 0;
}

/** Positional text wins; otherwise read piped stdin (never block on an interactive terminal). */
async function readText(positionals: string[], io: CliIO): Promise<string> {
  if (positionals.length > 0) return positionals.join(" ");
  if (io.stdinIsTTY) return "";
  return io.readStdin();
}
