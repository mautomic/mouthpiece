import { parseArgs } from "node:util";
import type * as Client from "@mouthpiece/client";
import { KINDS, type Kind, type SpeakEvent } from "@mouthpiece/core";

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  readStdin(): Promise<string>;
  stdinIsTTY: boolean;
}

export interface CliDeps {
  client: Pick<typeof Client, "speak" | "stop" | "skip" | "health">;
  startDaemon(): Promise<{ url: string }>;
}

const USAGE = `usage: mouthpiece <command>
  start                                   run the daemon in the foreground
  say [text…] [--source s] [--label l] [--kind response|alert|info] [--plain]
                                          speak text (reads stdin when no text is given)
  stop | skip | status`;

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
