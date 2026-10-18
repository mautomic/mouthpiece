import { expect, test } from "bun:test";
import { startDelayMs, wavAudioMs } from "./start-gate.ts";

test("a long enough first chunk starts right after its own render", () => {
  // Kokoro-like: 15 ms of rendering and 42 ms of audio per character.
  expect(startDelayMs([100, 150, 150], [{ renderMs: 1_500, audioMs: 4_200 }])).toBe(1_500);
});

test("a short opener waits until the next chunk can't be late", () => {
  // Chunk 1 is estimated ready at 255 + 150 × 15 × 1.2 = 2,955 ms; it's needed 714 ms after the start.
  expect(startDelayMs([17, 150], [{ renderMs: 255, audioMs: 714 }])).toBeCloseTo(2_241, 0);
});

test("measured renders replace the estimates", () => {
  const done = [
    { renderMs: 255, audioMs: 714 },
    { renderMs: 2_250, audioMs: 6_300 },
  ];
  expect(startDelayMs([17, 150], done)).toBeCloseTo(1_791, 0);
});

test("when rendering is slower than playback, the start waits for nearly all of it", () => {
  // 20 ms of rendering (24 with slack) for 10 ms of audio per character.
  expect(startDelayMs([10, 10, 10], [{ renderMs: 200, audioMs: 100 }])).toBeCloseTo(480, 0);
});

test("without audio lengths (not WAV) there is nothing to go on: start at once", () => {
  expect(startDelayMs([17, 150], [{ renderMs: 255, audioMs: undefined }])).toBe(0);
});

test("wavAudioMs: a PCM WAV's length, undefined for anything else", () => {
  const wav = new Uint8Array(44 + 24_000 * 4); // 1 s of 24 kHz float, mono
  const view = new DataView(wav.buffer);
  const ascii = (o: number, t: string) =>
    [...t].forEach((c, i) => {
      view.setUint8(o + i, c.charCodeAt(0));
    });
  ascii(0, "RIFF");
  view.setUint32(4, wav.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  ascii(36, "data");
  view.setUint32(40, 24_000 * 4, true);
  expect(wavAudioMs(wav)).toBe(1_000);
  expect(wavAudioMs(new Uint8Array([0xff, 0xfb, 0x90, 0]))).toBeUndefined();
});
