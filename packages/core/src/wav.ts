/** Samples quieter than this (in -1..1) count as silence. */
const SILENCE_THRESHOLD = 0.01;
const PCM = 1;
const FLOAT = 3;

/**
 * Cuts the silence before the first sound to at most `leadMs`, and after the last sound to at most
 * `trailMs`. Handles mono or multichannel 16-bit PCM and 32-bit float WAV; anything else, including
 * audio that is silent throughout, is returned unchanged.
 */
export function trimWavSilence(
  wav: Uint8Array,
  { leadMs, trailMs }: { leadMs: number; trailMs: number },
): Uint8Array {
  const parsed = parseWav(wav);
  if (!parsed) return wav;
  const { dataOffset, dataLength, rate, frameBytes, read } = parsed;
  const frames = Math.floor(dataLength / frameBytes);
  const loud = (frame: number) =>
    Math.abs(read(dataOffset + frame * frameBytes)) >= SILENCE_THRESHOLD;
  let first = 0;
  while (first < frames && !loud(first)) first++;
  if (first === frames) return wav;
  let last = frames - 1;
  while (!loud(last)) last--;
  const start = Math.max(0, first - Math.round((leadMs * rate) / 1000));
  const end = Math.min(frames, last + 1 + Math.round((trailMs * rate) / 1000));
  if (start === 0 && end === frames) return wav;

  const data = wav.subarray(dataOffset + start * frameBytes, dataOffset + end * frameBytes);
  const out = new Uint8Array(dataOffset + data.length);
  out.set(wav.subarray(0, dataOffset));
  out.set(data, dataOffset);
  const header = new DataView(out.buffer);
  header.setUint32(4, out.length - 8, true);
  header.setUint32(dataOffset - 4, data.length, true);
  return out;
}

interface ParsedWav {
  dataOffset: number;
  dataLength: number;
  rate: number;
  frameBytes: number;
  /** The first channel's sample at a byte offset, in -1..1. */
  read(offset: number): number;
}

function parseWav(wav: Uint8Array): ParsedWav | undefined {
  if (wav.length < 12 || ascii(wav, 0) !== "RIFF" || ascii(wav, 8) !== "WAVE") return undefined;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let format: number | undefined;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = ascii(wav, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && size >= 16) {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      rate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      const dataOffset = offset + 8;
      const dataLength = Math.min(size, wav.length - dataOffset);
      const frameBytes = (bits / 8) * channels;
      if (channels < 1 || rate < 1) return undefined;
      if (format === FLOAT && bits === 32) {
        return { dataOffset, dataLength, rate, frameBytes, read: (o) => view.getFloat32(o, true) };
      }
      if (format === PCM && bits === 16) {
        return {
          dataOffset,
          dataLength,
          rate,
          frameBytes,
          read: (o) => view.getInt16(o, true) / 32768,
        };
      }
      return undefined;
    }
    offset += 8 + size + (size % 2); // chunks are padded to an even size
  }
  return undefined;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}
