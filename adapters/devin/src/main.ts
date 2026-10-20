// main.ts: entry point for Devin CLI hooks. Never prints; always exits 0 (FR-2, via hook-kit).
import { runHook } from "@mouthpiece/hook-kit";
import { handleHook } from "./hook.ts";

await runHook(handleHook);
