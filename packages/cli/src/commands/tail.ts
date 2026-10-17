import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  FileTailer,
  PARSERS,
  TAIL_FORMATS,
  type TailFormat,
  type TailMessage,
} from "@mouthpiece/adapter-file-tail";
import type { Env } from "@mouthpiece/core";
import type { CliDeps, CliIO } from "../types.ts";

/** Test seams: `signal` ends the tail (default: SIGINT), `pollMs` sets the poll interval. */
export type TailDeps = CliDeps & { signal?: AbortSignal; pollMs?: number };

const PATTERNS: Partial<Record<TailFormat, RegExp>> = {
  codex: /^rollout-.*\.jsonl$/,
  gemini: /^session-.*\.jsonl$/,
};

const isFormat = (v: string | undefined): v is TailFormat => TAIL_FORMATS.includes(v as TailFormat);

/** Where each tool keeps its session logs; `lines` has no default. */
export function defaultTailPath(format: TailFormat, env: Env): string | undefined {
  const home = env.HOME || homedir();
  if (format === "codex") return join(env.CODEX_HOME || join(home, ".codex"), "sessions");
  if (format === "gemini") return join(env.GEMINI_HOME || join(home, ".gemini"), "tmp");
  return undefined;
}

/** `mouthpiece tail --format codex|gemini|lines [--path p] [--source s] [--label l]` (US-014). */
export const tailCommand = async (args: string[], io: CliIO, deps: TailDeps): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      format: { type: "string" },
      path: { type: "string" },
      source: { type: "string" },
      label: { type: "string" },
    },
  });
  const format = values.format;
  if (!isFormat(format)) {
    io.err(`mouthpiece: tail needs --format ${TAIL_FORMATS.join("|")}\n`);
    return 2;
  }
  const path = values.path ?? defaultTailPath(format, deps.env);
  if (!path) {
    io.err(`mouthpiece: tail --format ${format} needs --path <file>\n`);
    return 2;
  }
  const source = values.source ?? (format === "lines" ? "cli" : format);

  // Speak in order, one request at a time; a failure is a warning, not the end of the tail.
  let pending: Promise<unknown> = Promise.resolve();
  const onMessage = (m: TailMessage) => {
    pending = pending.then(() =>
      deps.client
        .speak({
          text: m.text,
          source,
          conversationId: m.conversationId,
          label: values.label ?? m.label,
          kind: "response",
          format: "markdown",
        })
        .catch((error: Error) => io.err(`warning: ${error.message}\n`)),
    );
  };

  const tailer = new FileTailer({
    path,
    pattern: PATTERNS[format],
    parser: PARSERS[format],
    onMessage,
    onFollow: (file) => io.err(`following ${file}\n`),
    pollMs: deps.pollMs,
  });

  const signal = deps.signal ?? sigintSignal();
  const stopped = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  tailer.start();
  await tailer.poll();
  if (tailer.following === null) io.err(`waiting for ${path}\n`);
  await stopped;
  tailer.stop();
  await pending;
  return 0;
};

function sigintSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}
