import { type AudioClip, collectChunks, delay, type Player } from "@mouthpiece/core";

/** Test player: records decoded clip text when playback starts, then "plays" for durationMs. */
export class FakePlayer implements Player {
  readonly played: string[] = [];
  readonly gapless: boolean;

  constructor(private readonly opts: { durationMs?: number; gapless?: boolean } = {}) {
    this.gapless = opts.gapless ?? false;
  }

  async play(clip: AudioClip, signal: AbortSignal): Promise<void> {
    const text = new TextDecoder().decode(await collectChunks(clip.chunks));
    if (signal.aborted) return;
    this.played.push(text);
    if (this.opts.durationMs) await delay(this.opts.durationMs, signal).catch(() => {});
  }
}
