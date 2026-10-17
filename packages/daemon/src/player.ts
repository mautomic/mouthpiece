import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type AudioClip, collectChunks, type Player } from "@mouthpiece/core";

export interface AfplayPlayerOptions {
  tmpDir: string;
  /** The clip's file path is appended. Default: ["afplay"]. */
  command?: string[];
}

/** MVP player: buffers each clip to a temp file and plays it with afplay (PRD §8.4). */
export class AfplayPlayer implements Player {
  constructor(private readonly opts: AfplayPlayerOptions) {}

  async play(clip: AudioClip, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const bytes = await collectChunks(clip.chunks);
    if (signal.aborted) return;
    await mkdir(this.opts.tmpDir, { recursive: true });
    const path = join(this.opts.tmpDir, `${crypto.randomUUID()}.${clip.format}`);
    await Bun.write(path, bytes);
    try {
      const proc = Bun.spawn([...(this.opts.command ?? ["afplay"]), path], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const onAbort = () => proc.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const code = await proc.exited;
        if (code !== 0 && !signal.aborted) throw new Error(`player exited with ${code}`);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } finally {
      await rm(path, { force: true });
    }
  }
}
