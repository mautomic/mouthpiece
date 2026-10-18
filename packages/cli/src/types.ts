import type * as Client from "@mouthpiece/client";
import type { Env, Exec } from "@mouthpiece/core";

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  readStdin(): Promise<string>;
  stdinIsTTY: boolean;
}

export interface CliDeps {
  client: Pick<
    typeof Client,
    | "speak"
    | "stop"
    | "skip"
    | "health"
    | "getMode"
    | "setMode"
    | "replay"
    | "usage"
    | "voices"
    | "status"
    | "pause"
    | "resume"
  >;
  startDaemon(): Promise<{ url: string }>;
  env: Env;
  exec: Exec;
  paths: { repoRoot: string; bun: string };
}

/**
 * Client timeout for requests where the daemon itself waits on providers: `voices` (up to
 * VOICES_TIMEOUT_MS per provider) and `usage` (up to PROVIDER_USAGE_TIMEOUT_MS), both in
 * packages/daemon/src/daemon.ts. Keep it above both, or the CLI gives up before the daemon replies.
 */
export const SLOW_REQUEST_TIMEOUT_MS = 10_000;

export type CommandFn = (args: string[], io: CliIO, deps: CliDeps) => Promise<number>;
