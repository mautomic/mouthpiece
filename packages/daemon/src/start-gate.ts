import { readWavPcm } from "@mouthpiece/core";

/** One rendered chunk: how long it took, and how long it plays (undefined when unknown). */
export interface ChunkTiming {
  renderMs: number;
  audioMs: number | undefined;
}

/**
 * How long after the first render starts playback can begin and never wait (the user's rule: once
 * speech starts it is continuous). Chunks render one after another, so chunk j is ready at the sum
 * of render times through j, and playback reaches it at the start plus the audio before it.
 * `done` holds the chunks rendered so far, in order (at least one); the rest are estimated from
 * their speeds, with render times inflated by `slack`. 0 when an audio length is unknown.
 */
export function startDelayMs(chars: number[], done: ChunkTiming[], slack = 1.2): number {
  if (done.some((t) => t.audioMs === undefined)) return 0;
  const doneChars = chars.slice(0, done.length).reduce((a, b) => a + b, 0);
  const renderPerChar = (done.reduce((a, t) => a + t.renderMs, 0) / doneChars) * slack;
  const audioPerChar = done.reduce((a, t) => a + (t.audioMs ?? 0), 0) / doneChars;
  let ready = 0;
  let before = 0;
  let delay = 0;
  chars.forEach((count, j) => {
    const timing = done[j];
    ready += timing ? timing.renderMs : count * renderPerChar;
    delay = Math.max(delay, ready - before);
    before += timing ? (timing.audioMs ?? 0) : count * audioPerChar;
  });
  return delay;
}

/** A PCM WAV's length in milliseconds; undefined for anything else. */
export function wavAudioMs(bytes: Uint8Array): number | undefined {
  const pcm = readWavPcm(bytes);
  if (!pcm) return undefined;
  const bytesPerFrame = pcm.channels * (pcm.encoding === "f32le" ? 4 : 2);
  return (pcm.data.length / bytesPerFrame / pcm.sampleRate) * 1000;
}
