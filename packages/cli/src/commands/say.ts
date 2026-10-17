import { parseArgs } from "node:util";
import { KINDS, type Kind, type SpeakEvent } from "@mouthpiece/core";
import type { CliIO, CommandFn } from "../types.ts";

/** `mouthpiece say [text…]` (US-013). Reads piped stdin when no text is given. */
export const sayCommand: CommandFn = async (args, io, deps) => {
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
};

/** Positional text wins; otherwise read piped stdin (never block on an interactive terminal). */
async function readText(positionals: string[], io: CliIO): Promise<string> {
  if (positionals.length > 0) return positionals.join(" ");
  if (io.stdinIsTTY) return "";
  return io.readStdin();
}
