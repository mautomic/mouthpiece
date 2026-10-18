// run.ts: the shared hook runtime (FR-2). Never writes to stdout or stderr, always exits 0,
// gives up on the daemon after a short timeout, and exits hard if anything hangs.
import { readFile } from "node:fs/promises";
import { interrupt, speak } from "@mouthpiece/client";
import type { Env, InterruptRequest, SpeakEvent } from "@mouthpiece/core";

export interface HookContext {
  speak(e: SpeakEvent): Promise<unknown>;
  interrupt(r: InterruptRequest): Promise<unknown>;
  readFile(p: string): Promise<string>;
  env: Env;
}

export type HookHandler = (event: string, input: unknown, ctx: HookContext) => Promise<void>;

export interface RunHookOptions {
  argv?: string[];
  env?: Env;
  stdin?: () => Promise<string>;
  exit?: (code: number) => never;
  clientTimeoutMs?: number;
  hardExitMs?: number;
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const DEFAULT_CLIENT_TIMEOUT_MS = 300;
export const DEFAULT_HARD_EXIT_MS = 1000;

/** Reads stdin, stopping once it holds more than MAX_STDIN_BYTES (the caller then ignores it). */
async function readStdinLimited(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > MAX_STDIN_BYTES) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(handler: HookHandler, opts: RunHookOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const realExit = opts.exit ?? ((code: number) => process.exit(code));
  let exited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    realExit(0);
  };
  if (env.MOUTHPIECE_CHILD === "1") return finish();

  timer = setTimeout(finish, opts.hardExitMs ?? DEFAULT_HARD_EXIT_MS);
  timer.unref?.();
  if (!opts.exit) {
    // A real hook process: nothing may reach stderr, not even a stray rejection.
    process.on("uncaughtException", finish);
    process.on("unhandledRejection", finish);
  }

  try {
    const text = await (opts.stdin ?? readStdinLimited)();
    if (Buffer.byteLength(text, "utf8") > MAX_STDIN_BYTES) return finish();
    const input: unknown = JSON.parse(text);
    const client = { timeoutMs: opts.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS, env };
    await handler((opts.argv ?? process.argv)[2] ?? "", input, {
      speak: (e) => speak(e, client),
      interrupt: (r) => interrupt(r, client),
      readFile: (p) => readFile(p, "utf8"),
      env,
    });
  } catch {
    // Swallowed: a hook must never fail its host tool.
  }
  finish();
}
