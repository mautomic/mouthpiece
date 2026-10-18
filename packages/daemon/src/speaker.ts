import {
  type AudioClip,
  type Config,
  chunkText,
  type Logger,
  type NormalizedSpeakEvent,
  type Player,
  shouldSpeak,
  type TtsProvider,
} from "@mouthpiece/core";
import { speakable } from "./prepare.ts";
import type { PlayFn, QueueItem } from "./queue.ts";
import type { Prepared, SpokenRecord } from "./types.ts";

export interface SpeakerDeps {
  provider: TtsProvider;
  player: Player;
  log: Logger;
  now?: () => number;
  /** Decides what to say (see createPreparer). */
  prepare(event: NormalizedSpeakEvent): Promise<Prepared>;
  onSpoken?(record: SpokenRecord): void;
}

type Synthesis = { ok: true; clip: AudioClip } | { ok: false; error: unknown };

/**
 * prepare → label → chunk → synthesize (next chunk prefetched while the current one plays) → play.
 * A resumed item (US-022) starts at ctx.startChunk; the preparer memoizes per event, so the chunks
 * match the interrupted play's.
 */
export function createSpeaker(deps: SpeakerDeps): PlayFn {
  const now = deps.now ?? Date.now;
  // Items already recorded, so one resumed from chunk 0 (paused before its first chunk) is recorded once.
  const recorded = new WeakSet<QueueItem>();
  return async (item, { announceLabel, signal, startChunk, onChunk }) => {
    const prepared = await deps.prepare(item.event);
    if (signal.aborted) return;
    const resumed = startChunk > 0 || recorded.has(item);
    if (!resumed) {
      recorded.add(item);
      deps.onSpoken?.({
        id: item.id,
        event: item.event,
        full: prepared.full,
        summary: prepared.summary,
        spoken: prepared.spoken,
        at: now(),
      });
    }
    const body = prepared.spoken;
    const text = announceLabel && item.event.label ? `${item.event.label}: ${body}` : body;
    const chunks = chunkText(text, { maxChars: deps.provider.maxCharsPerRequest });
    const synthesize = (chunk: string): Promise<Synthesis> =>
      deps.provider
        .synthesize(chunk, {
          signal,
          tag: item.event.source,
          voice: item.event.voice,
          label: item.event.label,
        })
        .then(
          (clip) => ({ ok: true, clip }),
          (error) => ({ ok: false, error }),
        );
    const logChunkFailure = (chunk: number, error: unknown) =>
      deps.log({ level: "error", msg: "chunk_failed", id: item.id, chunk, error: String(error) });
    const firstChunk = chunks[startChunk];
    let next = firstChunk === undefined ? undefined : synthesize(firstChunk);
    for (let i = startChunk; next && !signal.aborted; i++) {
      // Chunk i is now the one in progress (synthesizing, then playing), so a pause resumes here.
      onChunk(i);
      const result = await next;
      if (signal.aborted) return;
      const following = chunks[i + 1];
      next = following === undefined ? undefined : synthesize(following);
      if (!result.ok) {
        logChunkFailure(i, result.error);
        continue;
      }
      if (i === startChunk && !resumed)
        deps.log({ msg: "first_audio", id: item.id, latencyMs: now() - item.enqueuedAt });
      try {
        await deps.player.play(result.clip, signal);
      } catch (error) {
        if (!signal.aborted) logChunkFailure(i, error);
      }
    }
  };
}

export function skipReason(event: NormalizedSpeakEvent, filter: Config["filter"]): string | null {
  if (event.kind !== "response") return null;
  return shouldSpeak(speakable(event), filter) ? null : "trivial";
}
