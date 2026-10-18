import { parseArgs } from "node:util";
import { type CommandFn, SLOW_REQUEST_TIMEOUT_MS } from "../types.ts";

/** `mouthpiece voices [--provider x]` (US-015): every provider's voices, one per line. */
export const voicesCommand: CommandFn = async (args, io, deps) => {
  const { values } = parseArgs({
    args,
    options: { provider: { type: "string" } },
  });
  const { providers } = await deps.client.voices({
    timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
    ...(values.provider ? { provider: values.provider } : {}),
  });
  const lines: string[] = [];
  for (const entry of providers) {
    lines.push(`provider: ${entry.provider}`);
    if (entry.error !== undefined) lines.push(`  (error: ${entry.error})`);
    else if (entry.voices.length === 0) lines.push("  (no voices)");
    for (const v of entry.voices) {
      lines.push(`  ${[v.id, v.name, v.language].filter((f) => f !== undefined).join("  ")}`);
    }
  }
  if (lines.length > 0) io.out(`${lines.join("\n")}\n`);
  return 0;
};
