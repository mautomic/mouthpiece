import { mkdir } from "node:fs/promises";
import type { Env, Summarizer } from "@mouthpiece/core";
import { summaryPrompt, wrapMessage } from "./prompt.ts";
import { trimKeepingLast } from "./trim.ts";

export interface ClaudeCliOptions {
  command: string;
  model: string;
  timeoutMs: number;
  maxChars: number;
  /** Working dir for the child (keeps any artifacts out of user projects). */
  cwd: string;
  env: Env;
}

/** Summarizes on the user's logged-in Claude subscription via `claude -p` (no API key). */
export class ClaudeCliSummarizer implements Summarizer {
  readonly name = "claude-cli";

  constructor(private readonly opts: ClaudeCliOptions) {}

  async summarize(
    text: string,
    options: { source: string; signal?: AbortSignal; maxSentences?: number },
  ): Promise<string> {
    options.signal?.throwIfAborted();
    await mkdir(this.opts.cwd, { recursive: true });
    // An abort during mkdir would otherwise be missed: the listener below is attached after spawn.
    options.signal?.throwIfAborted();
    const args = [
      this.opts.command,
      "-p",
      "--model",
      this.opts.model,
      "--tools",
      "",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--system-prompt",
      summaryPrompt(this.opts.maxChars, text.length, options.maxSentences),
    ];
    const proc = Bun.spawn(args, {
      cwd: this.opts.cwd,
      env: { ...this.opts.env, MOUTHPIECE_CHILD: "1" } as Record<string, string>,
      stdin: new TextEncoder().encode(wrapMessage(text)),
      stdout: "pipe",
      stderr: "pipe",
    });
    // On timeout/abort, reject right away: a grandchild that inherited the pipes could
    // otherwise keep stdout open (and this promise pending) after the child is killed.
    let stop: (error: unknown) => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      stop = reject;
    });
    const timer = setTimeout(() => {
      proc.kill();
      stop(new Error(`summarizer timed out after ${this.opts.timeoutMs}ms`));
    }, this.opts.timeoutMs);
    const onAbort = () => {
      proc.kill();
      stop(options.signal?.reason ?? new Error("aborted"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        stopped,
      ]);
      options.signal?.throwIfAborted();
      if (code !== 0) throw new Error(`claude exited with ${code}: ${stderr.trim()}`);
      // Cut from the middle: the summary ends with what the user needs to do.
      // Code and emphasis marks the model sometimes adds would be read out; underscores stay
      // (voice ids like af_bella).
      const spoken = stdout.trim().replace(/[`*]/g, "");
      const summary = trimKeepingLast(spoken, this.opts.maxChars);
      if (!summary) throw new Error("empty summary");
      return summary;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
