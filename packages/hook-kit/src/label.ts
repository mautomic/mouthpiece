import { basename } from "node:path";

/** The project label for a hook payload's `cwd`: its directory name (US-012). */
export function labelFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== "string") return undefined;
  return basename(cwd) || undefined;
}
