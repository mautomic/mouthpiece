import {
  type AudioClip,
  delay,
  type SynthesizeOptions,
  singleChunk,
  type TtsProvider,
} from "@mouthpiece/core";

export interface FakeProviderOptions {
  name?: string;
  maxCharsPerRequest?: number;
  delayMs?: number;
  failWith?: Error;
  failMidStream?: boolean | ((text: string) => boolean);
  cacheKey?: string;
}

/** Deterministic provider for tests: the "audio" is the UTF-8 text itself. */
export class FakeProvider implements TtsProvider {
  readonly name: string;
  readonly maxCharsPerRequest: number;
  readonly pricePerMillionChars = 0;
  readonly calls: string[] = [];
  readonly options: SynthesizeOptions[] = [];
  readonly cacheKey: string | undefined;

  constructor(private readonly opts: FakeProviderOptions = {}) {
    this.name = opts.name ?? "fake";
    this.cacheKey = opts.cacheKey;
    this.maxCharsPerRequest = opts.maxCharsPerRequest ?? 1000;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    this.calls.push(text);
    this.options.push(options);
    if (this.opts.delayMs) await delay(this.opts.delayMs, options.signal);
    if (this.opts.failWith) throw this.opts.failWith;
    const bytes = new TextEncoder().encode(text);
    const failMid =
      typeof this.opts.failMidStream === "function"
        ? this.opts.failMidStream(text)
        : this.opts.failMidStream;
    return { format: "mp3", chunks: failMid ? brokenStream(bytes) : singleChunk(bytes) };
  }
}

async function* brokenStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes.slice(0, 1);
  throw new Error("fake mid-stream failure");
}
