import { writeFile } from "node:fs/promises";

export interface WriteUntilOptions {
  /** Give up (throw) after this long. Default 8000. */
  timeoutMs?: number;
  /** Write the same content again when `done` still fails after this long. Default 1000. */
  rewriteMs?: number;
}

/**
 * Test helper for hot reload (FR-11). Writes `content` to `path` and waits until `done()` holds.
 * A write made right after the watcher starts can go unnoticed (macOS can drop or delay that first
 * event, especially under load), so the same content is written again every `rewriteMs` while
 * waiting. Rewriting identical content doesn't change what `done()` checks.
 */
export async function writeUntil(
  path: string,
  content: string,
  done: () => boolean | Promise<boolean>,
  { timeoutMs = 8_000, rewriteMs = 1_000 }: WriteUntilOptions = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let nextWrite = 0;
  while (!(await done())) {
    const now = performance.now();
    if (now > deadline) throw new Error(`not applied within ${timeoutMs} ms of writing ${path}`);
    if (now >= nextWrite) {
      await writeFile(path, content);
      nextWrite = now + rewriteMs;
    }
    await Bun.sleep(25);
  }
}
