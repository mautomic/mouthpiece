import { type AudioClip, collectChunks, delay, type Player } from "@mouthpiece/core";

/** Test player: records decoded clip text when playback starts, then "plays" for durationMs. */
export class FakePlayer implements Player {
  readonly played: string[] = [];

  constructor(private readonly opts: { durationMs?: number } = {}) {}

  async play(clip: AudioClip, signal: AbortSignal): Promise<void> {
    const text = new TextDecoder().decode(await collectChunks(clip.chunks));
    if (signal.aborted) return;
    this.played.push(text);
    if (this.opts.durationMs) await delay(this.opts.durationMs, signal).catch(() => {});
  }
}
