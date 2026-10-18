import { join } from "node:path";
import type { Config, Env, Summarizer } from "@mouthpiece/core";
import { ClaudeCliSummarizer } from "./claude-cli.ts";

export function createSummarizer(
  config: Config,
  deps: { home: string; env: Env },
): Summarizer | undefined {
  const s = config.summarizer;
  if (s.backend === "none") return undefined;
  return new ClaudeCliSummarizer({
    command: s.command,
    model: s.model,
    timeoutMs: s.timeoutMs,
    maxChars: s.maxChars,
    cwd: join(deps.home, "summarizer"),
    env: deps.env,
  });
}
