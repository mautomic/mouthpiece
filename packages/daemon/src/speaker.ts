import {
  type AudioClip,
  type ChunkPacking,
  type Config,
  chunkText,
  collectChunks,
  delay,
  type Logger,
  type NormalizedSpeakEvent,
  type Player,
  shouldSpeak,
  singleChunk,
  type TtsProvider,
} from "@mouthpiece/core";
import { speakable } from "./prepare.ts";
import type { PlayFn, QueueItem } from "./queue.ts";
import { type ChunkTiming, startDelayMs, wavAudioMs } from "./start-gate.ts";
import type { Prepared, SpokenRecord } from "./types.ts";

export interface SpeakerDeps {
  provider: TtsProvider;
  player: Player;
  log: Logger;
  now?: () => number;
  /** Decides what to say (see createPreparer). */
  prepare(event: NormalizedSpeakEvent): Promise<Prepared>;
  onSpoken?(record: SpokenRecord): void;
  /** Called just before each clip of `item` starts playing. */
  onAudio?(item: QueueItem): void;
}

type Synthesis = { ok: true; clip: AudioClip } | { ok: false; error: unknown };

type Rendered = { result: Synthesis; timing: ChunkTiming };

/**
 * Renders `texts` one after another, each starting when the one before is done, as fast as the
 * provider goes; records each one's render time and audio length.
 */
function renderInOrder(
  texts: string[],
  synthesize: (text: string) => Promise<Synthesis>,
  now: () => number,
): Promise<Rendered>[] {
  const out: Promise<Rendered>[] = [];
  let previous: Promise<unknown> = Promise.resolve();
  for (const text of texts) {
    // Never rejects: a failure (including a stream that breaks or is aborted midway) is a failed
    // chunk, logged and skipped, like the prefetch path does.
    const rendered = previous.then(async (): Promise<Rendered> => {
      const started = now();
      const failed = (error: unknown): Rendered => ({
        result: { ok: false, error },
        timing: { renderMs: now() - started, audioMs: 0 },
      });
      try {
        const result = await synthesize(text);
        if (!result.ok) return failed(result.error);
        const bytes = await collectChunks(result.clip.chunks);
        const clip = { format: result.clip.format, chunks: singleChunk(bytes) };
        const audioMs = clip.format === "wav" ? wavAudioMs(bytes) : undefined;
        return { result: { ok: true, clip }, timing: { renderMs: now() - started, audioMs } };
      } catch (error) {
        return failed(error);
      }
    });
    out.push(rendered);
    previous = rendered;
  }
  return out;
}

/**
 * Waits until playback can start and never wait for a render (startDelayMs), re-estimating as each
 * render finishes. Returns false if `signal` aborts.
 */
async function waitForStart(
  chars: number[],
  renders: Promise<Rendered>[],
  startedAt: number,
  now: () => number,
  signal: AbortSignal,
): Promise<boolean> {
  const first = renders[0];
  if (!first) return true;
  const done: ChunkTiming[] = [(await first).timing];
  for (;;) {
    if (signal.aborted) return false;
    const wait = startDelayMs(chars, done) - (now() - startedAt);
    const next = renders[done.length];
    if (wait <= 0 || !next) return true;
    const winner = await Promise.race([
      delay(wait, signal).then(
        () => "time" as const,
        () => "aborted" as const,
      ),
      next.then(() => "render" as const),
    ]);
    if (winner === "aborted") return false;
    if (winner === "time") return true;
    done.push((await next).timing);
  }
}

/**
 * prepare → label → chunk → synthesize (next chunk prefetched while the current one plays) → play.
 * A resumed item (US-022) starts at ctx.startChunk of the chunk list frozen on its first play, so a
 * chain change while paused (a new maxCharsPerRequest) can't shift or drop chunks.
 * With a gap-free player and a provider that renders before it plays (a chunking hint), every chunk
 * is rendered ahead and playback starts only once the rest can keep up (startDelayMs).
 */
export function createSpeaker(deps: SpeakerDeps): PlayFn {
  const now = deps.now ?? Date.now;
  // Items already recorded, so one resumed from chunk 0 (paused before its first chunk) is recorded once.
  const recorded = new WeakSet<QueueItem>();
  // Each item's chunk list, frozen on first play; a resume indexes into it.
  const frozen = new WeakMap<QueueItem, string[]>();
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
    const hint = deps.provider.chunking;
    const packing = deps.player.gapless ? hint?.gapless : hint?.withBreaks;
    const max = deps.provider.maxCharsPerRequest;
    const chunks = chunksFor(frozen.get(item), text, startChunk, max, packing);
    frozen.set(item, chunks);
    const synthesize = (chunk: string): Promise<Synthesis> =>
      deps.provider
        .synthesize(chunk, {
          signal,
          tag: item.event.source,
          source: item.event.source,
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
    if (firstChunk === undefined && startChunk > 0) {
      deps.log({ level: "warn", msg: "resume_past_end", id: item.id, chunk: startChunk });
    }
    // A gap-free player with a local provider: render everything ahead, and start only when the rest
    // can keep up, so speech never pauses once it starts (a longer start is fine).
    if (deps.player.gapless && deps.provider.chunking && firstChunk !== undefined) {
      const rest = chunks.slice(startChunk);
      const startedAt = now();
      const renders = renderInOrder(rest, synthesize, now);
      const chars = rest.map((c) => c.length);
      if (!(await waitForStart(chars, renders, startedAt, now, signal))) return;
      for (const [offset, render] of renders.entries()) {
        const i = startChunk + offset;
        onChunk(i);
        const { result } = await render;
        if (signal.aborted) return;
        if (!result.ok) {
          logChunkFailure(i, result.error);
          continue;
        }
        if (offset === 0 && !resumed)
          deps.log({ msg: "first_audio", id: item.id, latencyMs: now() - item.enqueuedAt });
        deps.onAudio?.(item);
        try {
          await deps.player.play(result.clip, signal);
        } catch (error) {
          if (!signal.aborted) logChunkFailure(i, error);
        }
      }
      return;
    }
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
      deps.onAudio?.(item);
      try {
        await deps.player.play(result.clip, signal);
      } catch (error) {
        if (!signal.aborted) logChunkFailure(i, error);
      }
    }
  };
}

/**
 * The frozen list when there is one; a chunk from startChunk on that the provider can no longer
 * take is re-split together with everything after it (earlier indices stay put).
 */
function chunksFor(
  frozen: string[] | undefined,
  text: string,
  startChunk: number,
  maxChars: number,
  packing: ChunkPacking | undefined,
): string[] {
  if (!frozen) return chunkText(text, { maxChars, ...packing });
  const tooLong = frozen.findIndex((c, i) => i >= startChunk && c.length > maxChars);
  if (tooLong === -1) return frozen;
  const rest = frozen.slice(tooLong).join(" ");
  return [
    ...frozen.slice(0, tooLong),
    ...chunkText(rest, { maxChars, targetChars: packing?.targetChars }),
  ];
}

export function skipReason(event: NormalizedSpeakEvent, filter: Config["filter"]): string | null {
  if (event.kind !== "response") return null;
  const text = speakable(event);
  // A verbatim source wrote its text to be heard, however short; only an empty one is skipped.
  if (event.verbatim) return text.trim() === "" ? "trivial" : null;
  return shouldSpeak(text, filter) ? null : "trivial";
}
