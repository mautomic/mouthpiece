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
    "speak" | "stop" | "skip" | "health" | "getMode" | "setMode" | "replay" | "usage" | "voices"
  >;
  startDaemon(): Promise<{ url: string }>;
  env: Env;
  exec: Exec;
  paths: { repoRoot: string; bun: string };
}

export type CommandFn = (args: string[], io: CliIO, deps: CliDeps) => Promise<number>;
