import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { MouthpieceError } from "@mouthpiece/client";
import {
  cleanForSpeech,
  type Format,
  KINDS,
  type Kind,
  MODES,
  type Mode,
  PRIORITIES,
  type Priority,
  type SpeakEvent,
} from "@mouthpiece/core";
import type { CliDeps, CliIO, CommandFn } from "../types.ts";

const START_HINT = "start it with `mouthpiece start` or `./install.sh`";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

/**
 * `mouthpiece say [text…]` (US-013). Reads piped stdin when no text is given, or `--file`.
 * With `--fallback-say`, an unreachable daemon is replaced by a local `/usr/bin/say`.
 */
export const sayCommand: CommandFn = async (args, io, deps) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: "string", default: "cli" },
      label: { type: "string" },
      kind: { type: "string", default: "response" },
      plain: { type: "boolean", default: false },
      markdown: { type: "boolean", default: false },
      file: { type: "string" },
      mode: { type: "string" },
      voice: { type: "string" },
      priority: { type: "string" },
      "fallback-say": { type: "boolean", default: false },
    },
  });
  const invalid =
    oneOf("--kind", values.kind, KINDS) ??
    oneOf("--mode", values.mode, MODES) ??
    oneOf("--priority", values.priority, PRIORITIES);
  if (invalid) {
    io.err(`mouthpiece: ${invalid}\n`);
    return 2;
  }
  if (values.file !== undefined && positionals.length > 0) {
    io.err("mouthpiece: pass text or --file, not both\n");
    return 2;
  }

  let raw: string;
  if (values.file !== undefined) {
    try {
      raw = await readFile(values.file, "utf8");
    } catch (error) {
      io.err(`mouthpiece: cannot read ${values.file}: ${(error as Error).message}\n`);
      return 2;
    }
  } else {
    raw = await readText(positionals, io);
  }
  const text = raw.trim();
  if (!text) {
    io.err("mouthpiece: nothing to say (pass text or pipe it in)\n");
    return 2;
  }

  const format = formatFor(values);
  const event: SpeakEvent = {
    text,
    source: values.source,
    ...(values.label ? { label: values.label } : {}),
    kind: values.kind as Kind,
    format,
    ...(values.mode ? { mode: values.mode as Mode } : {}),
    ...(values.voice ? { voice: values.voice } : {}),
    ...(values.priority ? { priority: values.priority as Priority } : {}),
  };
  try {
    io.out(`${JSON.stringify(await deps.client.speak(event))}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof MouthpieceError && error.message.includes("unreachable"))) throw error;
    if (values["fallback-say"]) return await speakLocally(text, format, io, deps);
    io.err(`mouthpiece: ${error.message}\n  ${START_HINT}\n`);
    return 1;
  }
};

function oneOf(flag: string, value: string | undefined, allowed: readonly string[]) {
  return value === undefined || allowed.includes(value)
    ? undefined
    : `${flag} must be one of ${allowed.join(", ")}`;
}

/** `--plain` always wins; a file is markdown only for .md/.markdown (or with `--markdown`). */
function formatFor(values: { plain: boolean; markdown: boolean; file?: string }): Format {
  if (values.plain) return "plain";
  if (values.file === undefined || values.markdown) return "markdown";
  return MARKDOWN_EXTENSIONS.has(extname(values.file).toLowerCase()) ? "markdown" : "plain";
}

/** Speaks through the built-in `say` when the daemon is down (US-013 `--fallback-say`). */
async function speakLocally(
  text: string,
  format: Format,
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "mouthpiece-say-"));
  try {
    const file = join(dir, "text.txt");
    await writeFile(file, format === "plain" ? text : cleanForSpeech(text));
    const result = await deps.exec(["/usr/bin/say", "-f", file]);
    if (result.code !== 0) {
      io.err(`mouthpiece: local say failed: ${result.stderr.trim() || `exit ${result.code}`}\n`);
      return 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  io.err("spoke locally (daemon unreachable)\n");
  return 0;
}

/** Positional text wins; otherwise read piped stdin (never block on an interactive terminal). */
async function readText(positionals: string[], io: CliIO): Promise<string> {
  if (positionals.length > 0) return positionals.join(" ");
  if (io.stdinIsTTY) return "";
  return io.readStdin();
}
