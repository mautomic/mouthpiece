// main.ts: entry point for Claude Code hooks. Never prints to stdout; always exits 0 (FR-2).
import { readFile } from "node:fs/promises";
import { interrupt, speak } from "@mouthpiece/client";
import { handleHook } from "./hook.ts";

const CLIENT_TIMEOUT_MS = 300;
const HARD_EXIT_MS = 1000;

setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();

async function main(): Promise<void> {
  if (process.env.MOUTHPIECE_CHILD === "1") return;
  const input: unknown = JSON.parse(await Bun.stdin.text());
  const opts = { timeoutMs: CLIENT_TIMEOUT_MS };
  await handleHook(process.argv[2] ?? "", input, {
    speak: (e) => speak(e, opts),
    interrupt: (r) => interrupt(r, opts),
    readFile: (p) => readFile(p, "utf8"),
    env: process.env,
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
