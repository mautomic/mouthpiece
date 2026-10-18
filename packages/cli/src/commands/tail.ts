import { parseArgs } from "node:util";
import { TAIL_FORMATS } from "@mouthpiece/adapter-file-tail";
import { createFollower, defaultTailPath, isFormat } from "../follow.ts";
import type { CliDeps, CliIO } from "../types.ts";

export { defaultTailPath } from "../follow.ts";

/** Test seams: `signal` ends the tail (default: SIGINT), `pollMs` sets the poll interval. */
export type TailDeps = CliDeps & { signal?: AbortSignal; pollMs?: number };

/** `mouthpiece tail --format codex|gemini|lines|margin [--path p] [--source s] [--label l]` (US-014). */
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
  const follower = createFollower(
    { format, path: values.path, source: values.source, label: values.label },
    {
      speak: (e) => deps.client.speak(e),
      env: deps.env,
      warn: io.err,
      onFollow: (file) => io.err(`following ${file}\n`),
      pollMs: deps.pollMs,
    },
  );
  if ("error" in follower) {
    io.err(`mouthpiece: tail --format ${format} needs --path <file>\n`);
    return 2;
  }

  const signal = deps.signal ?? sigintSignal();
  const stopped = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  follower.start();
  await follower.poll();
  if (follower.following?.() === null) {
    io.err(`waiting for ${values.path ?? defaultTailPath(format, deps.env)}\n`);
  }
  await stopped;
  await follower.stop();
  return 0;
};

function sigintSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}
