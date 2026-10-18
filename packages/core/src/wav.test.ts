import { expect, test } from "bun:test";
import { trimWavSilence } from "./wav.ts";

const RATE = 1000; // 1 sample per ms keeps the arithmetic readable

/** A mono WAV of `samples` (-1..1) as 32-bit float (format 3) or 16-bit PCM (format 1). */
function wav(samples: number[], format: 1 | 3 = 3): Uint8Array {
  const bytesPerSample = format === 3 ? 4 : 2;
  const data = samples.length * bytesPerSample;
  const out = new DataView(new ArrayBuffer(44 + data));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  out.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, format, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * bytesPerSample, true);
  out.setUint16(32, bytesPerSample, true);
  out.setUint16(34, bytesPerSample * 8, true);
  ascii(36, "data");
  out.setUint32(40, data, true);
  samples.forEach((s, i) => {
    if (format === 3) out.setFloat32(44 + i * 4, s, true);
    else out.setInt16(44 + i * 2, Math.round(s * 32767), true);
  });
  return new Uint8Array(out.buffer);
}

/** The samples of a WAV made by `wav()`, with its header sizes checked. */
function samplesOf(bytes: Uint8Array, format: 1 | 3 = 3): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = format === 3 ? 4 : 2;
  expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  expect(view.getUint32(40, true)).toBe(bytes.length - 44);
  return Array.from({ length: (bytes.length - 44) / size }, (_, i) =>
    format === 3 ? view.getFloat32(44 + i * 4, true) : view.getInt16(44 + i * 2, true) / 32767,
  );
}

const silence = (ms: number) => new Array<number>(ms).fill(0);
const tone = (ms: number) => new Array<number>(ms).fill(0.5);

test("keeps at most leadMs of silence before the sound and trailMs after it", () => {
  const trimmed = trimWavSilence(wav([...silence(500), ...tone(200), ...silence(500)]), {
    leadMs: 20,
    trailMs: 250,
  });
  expect(samplesOf(trimmed)).toEqual([...silence(20), ...tone(200), ...silence(250)]);
});

test("shorter silence than the limits is left as it is", () => {
  const samples = [...silence(10), ...tone(100), ...silence(30)];
  expect(samplesOf(trimWavSilence(wav(samples), { leadMs: 20, trailMs: 250 }))).toEqual(samples);
});

test("trims 16-bit PCM too, treating faint noise as silence", () => {
  const noise = new Array<number>(300).fill(0.002);
  const trimmed = trimWavSilence(wav([...noise, ...tone(100), ...noise], 1), {
    leadMs: 0,
    trailMs: 50,
  });
  const out = samplesOf(trimmed, 1);
  expect(out).toHaveLength(150);
  expect(out[0]).toBeCloseTo(0.5, 3);
});

test("leaves all-silent audio, unknown formats and non-WAV bytes unchanged", () => {
  const quiet = wav(silence(100));
  expect(trimWavSilence(quiet, { leadMs: 0, trailMs: 0 })).toBe(quiet);
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  expect(trimWavSilence(mp3, { leadMs: 0, trailMs: 0 })).toBe(mp3);
  const alaw = wav(tone(10), 3);
  new DataView(alaw.buffer).setUint16(20, 6, true);
  expect(trimWavSilence(alaw, { leadMs: 0, trailMs: 0 })).toBe(alaw);
});
