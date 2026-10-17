import {
  type AudioClip,
  type Config,
  chunkText,
  cleanForSpeech,
  type Logger,
  type NormalizedSpeakEvent,
  type Player,
  shouldSpeak,
  type TtsProvider,
} from "@mouthpiece/core";
import type { PlayFn } from "./queue.ts";

export interface SpeakerDeps {
  provider: TtsProvider;
  player: Player;
  log: Logger;
  now?: () => number;
}

type Synthesis = { ok: true; clip: AudioClip } | { ok: false; error: unknown };

const speakable = (e: NormalizedSpeakEvent) =>
  e.format === "plain" ? e.text : cleanForSpeech(e.text);

/** clean → label → chunk → synthesize (next chunk prefetched while the current one plays) → play. */
export function createSpeaker(deps: SpeakerDeps): PlayFn {
  const now = deps.now ?? Date.now;
  return async (item, { announceLabel, signal }) => {
    const body = speakable(item.event);
    const text = announceLabel && item.event.label ? `${item.event.label}: ${body}` : body;
    const chunks = chunkText(text, { maxChars: deps.provider.maxCharsPerRequest });
    const synthesize = (chunk: string): Promise<Synthesis> =>
      deps.provider.synthesize(chunk, { signal }).then(
        (clip) => ({ ok: true, clip }),
        (error) => ({ ok: false, error }),
      );
    const [firstChunk] = chunks;
    let next = firstChunk === undefined ? undefined : synthesize(firstChunk);
    for (let i = 0; next && !signal.aborted; i++) {
      const result = await next;
      if (signal.aborted) return;
      const following = chunks[i + 1];
      next = following === undefined ? undefined : synthesize(following);
      if (!result.ok) {
        deps.log({
          level: "error",
          msg: "chunk_failed",
          id: item.id,
          chunk: i,
          error: String(result.error),
        });
        continue;
      }
      if (i === 0)
        deps.log({ msg: "first_audio", id: item.id, latencyMs: now() - item.enqueuedAt });
      try {
        await deps.player.play(result.clip, signal);
      } catch (error) {
        if (!signal.aborted)
          deps.log({
            level: "error",
            msg: "chunk_failed",
            id: item.id,
            chunk: i,
            error: String(error),
          });
      }
    }
  };
}

export function skipReason(event: NormalizedSpeakEvent, filter: Config["filter"]): string | null {
  if (event.kind !== "response") return null;
  return shouldSpeak(speakable(event), filter) ? null : "trivial";
}
