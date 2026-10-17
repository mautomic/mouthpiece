// main.ts: entry point for Gemini CLI hooks. Must print nothing to stdout or stderr and exit 0,
// or Gemini treats the output as a message (or retries the turn). hook-kit guarantees that.
import { runHook } from "@mouthpiece/hook-kit";
import { handleHook } from "./hook.ts";

await runHook(handleHook);
