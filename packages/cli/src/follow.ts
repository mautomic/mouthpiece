// follow.ts: a running tail of one format, speaking what its parser finds (US-014). Used by
// `mouthpiece tail` and by `mouthpiece start` for each `[[follow]]` config entry.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  FileTailer,
  MarginFollower,
  PARSERS,
  TAIL_FORMATS,
  type TailFormat,
  type TailMessage,
} from "@mouthpiece/adapter-file-tail";
import { configPath, type Env, loadConfig, type SpeakEvent } from "@mouthpiece/core";
import type { CliDeps, CliIO } from "./types.ts";

export interface FollowSpec {
  format: string;
  path?: string;
  source?: string;
  label?: string;
}

export interface Follower {
  start(): void;
  poll(): Promise<void>;
  /** Stops reading and resolves once every queued speak call has finished. */
  stop(): Promise<void>;
  /** File formats: the file being followed, or null while waiting for it to appear. */
  following?: () => string | null;
}

export interface FollowDeps {
  speak: (event: SpeakEvent) => Promise<unknown>;
  env: Env;
  warn: (message: string) => void;
  onFollow?: (file: string) => void;
  pollMs?: number;
}

const PATTERNS: Partial<Record<TailFormat, RegExp>> = {
  codex: /^rollout-.*\.jsonl$/,
  gemini: /^session-.*\.jsonl$/,
};

export const isFormat = (v: string | undefined): v is TailFormat =>
  TAIL_FORMATS.includes(v as TailFormat);

/** Where each tool keeps its session logs; `lines` has no default, and `margin` finds its own. */
export function defaultTailPath(format: TailFormat, env: Env): string | undefined {
  const home = env.HOME || homedir();
  if (format === "codex") return join(env.CODEX_HOME || join(home, ".codex"), "sessions");
  if (format === "gemini") return join(env.GEMINI_HOME || join(home, ".gemini"), "tmp");
  return undefined;
}

export function createFollower(spec: FollowSpec, deps: FollowDeps): Follower | { error: string } {
  const { format } = spec;
  if (!isFormat(format)) return { error: `unknown format ${format} (${TAIL_FORMATS.join(", ")})` };
  const source = spec.source ?? (format === "lines" ? "cli" : format);
  // Margin names its doc first every time: replies come from many docs at once.
  const announce = format === "margin" ? ({ announce: "always" } as const) : {};

  // Speak in order, one request at a time; a failure is a warning, not the end of the follower.
  let pending: Promise<unknown> = Promise.resolve();
  const onMessage = (m: TailMessage) => {
    pending = pending.then(() =>
      deps
        .speak({
          text: m.text,
          source,
          conversationId: m.conversationId,
          label: spec.label ?? m.label,
          kind: "response",
          format: "markdown",
          ...announce,
        })
        .catch((error: Error) => deps.warn(`warning: ${error.message}\n`)),
    );
  };
  const stopAfter = (reader: { stop(): void }) => async () => {
    reader.stop();
    await pending;
  };

  if (format === "margin") {
    const reader = new MarginFollower({
      doc: spec.path ? resolve(spec.path) : undefined,
      env: deps.env,
      onMessage,
      onFollow: deps.onFollow,
      pollMs: deps.pollMs,
    });
    return { start: () => reader.start(), poll: () => reader.poll(), stop: stopAfter(reader) };
  }
  const path = spec.path ?? defaultTailPath(format, deps.env);
  if (!path) return { error: `--format ${format} needs a path` };
  const reader = new FileTailer({
    path,
    pattern: PATTERNS[format],
    parser: PARSERS[format],
    onMessage,
    onFollow: deps.onFollow,
    pollMs: deps.pollMs,
  });
  return {
    start: () => reader.start(),
    poll: () => reader.poll(),
    stop: stopAfter(reader),
    following: () => reader.following,
  };
}

/** Starts a follower per entry; an invalid entry is a warning, never a failed start. */
export function startFollowers(entries: FollowSpec[], deps: FollowDeps): Follower[] {
  const followers: Follower[] = [];
  for (const entry of entries) {
    const follower = createFollower(entry, deps);
    if ("error" in follower) {
      deps.warn(`mouthpiece: follow ${entry.format}: ${follower.error}\n`);
      continue;
    }
    follower.start();
    followers.push(follower);
  }
  return followers;
}

/**
 * `mouthpiece start`: runs the config's `[[follow]]` entries beside the daemon at `url`, for the
 * life of the process. A config that can't be read starts none.
 */
export async function startConfiguredFollowers(
  url: string,
  io: CliIO,
  deps: CliDeps,
): Promise<void> {
  let entries: FollowSpec[];
  try {
    entries = (await loadConfig(configPath(deps.env))).follow;
  } catch (error) {
    io.err(`mouthpiece: follow: config not read (${(error as Error).message}); no followers\n`);
    return;
  }
  startFollowers(entries, {
    speak: (e) => deps.client.speak(e, { url, env: deps.env }),
    env: deps.env,
    warn: io.err,
    onFollow: (file) => io.err(`following ${file}\n`),
  });
}
