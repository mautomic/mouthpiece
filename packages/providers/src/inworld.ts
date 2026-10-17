import type { AudioClip, SynthesizeOptions, TtsProvider } from "@mouthpiece/core";

export const INWORLD_STREAM_URL = "https://api.inworld.ai/tts/v1/voice:stream";

export class InworldError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface InworldOptions {
  /** Base64 credential from the Inworld portal, sent as-is. */
  apiKey: string;
  model: string;
  voice: string;
  fetch?: typeof fetch;
  url?: string;
  /** Fail the stream if no bytes arrive for this long after it starts. Default 10,000 ms. */
  streamIdleTimeoutMs?: number;
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10_000;

export class InworldProvider implements TtsProvider {
  readonly name = "inworld";
  /** API limit is 4,000 UTF-16 units for streaming; 2,000 keeps chunks short for latency. */
  readonly maxCharsPerRequest = 2000;
  readonly pricePerMillionChars: number;
  readonly cacheKey: string;

  constructor(private readonly opts: InworldOptions) {
    this.pricePerMillionChars = opts.model.endsWith("-flash") ? 15 : 25;
    this.cacheKey = `${opts.voice}\u0000${opts.model}`;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    const response = await (this.opts.fetch ?? fetch)(this.opts.url ?? INWORLD_STREAM_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voiceId: options.voice ?? this.opts.voice,
        modelId: this.opts.model,
        audioConfig: { audioEncoding: "MP3", sampleRateHertz: 48000 },
      }),
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      throw new InworldError(
        `inworld HTTP ${response.status}: ${await response.text()}`,
        response.status,
      );
    }
    const stream = parseAudioStream(response.body, {
      idleTimeoutMs: this.opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      signal: options.signal,
    })[Symbol.asyncIterator]();
    // Resolve only once audio arrives (TtsProvider contract), so the fallback chain's
    // first-byte timeout and early error lines fall through to the next provider (FR-8).
    const first = await stream.next();
    if (first.done) throw new InworldError("inworld stream ended without audio");
    return { format: "mp3", chunks: prepend(first.value, stream) };
  }
}

async function* prepend(
  first: Uint8Array,
  rest: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  try {
    yield first;
    for (let next = await rest.next(); !next.done; next = await rest.next()) yield next.value;
  } finally {
    await rest.return?.();
  }
}

export interface ParseAudioStreamOptions {
  /** Throw if no bytes arrive for this long. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Inworld streams NDJSON: {"result":{"audioContent":"<base64>"}} per line; errors can arrive mid-stream. */
export async function* parseAudioStream(
  body: ReadableStream<Uint8Array>,
  opts: ParseAudioStreamOptions = {},
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (let part = await read(reader, opts); !part.done; part = await read(reader, opts)) {
      buffer += decoder.decode(part.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const audio = decodeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (audio) yield audio;
        newline = buffer.indexOf("\n");
      }
    }
    const last = decodeLine(buffer + decoder.decode());
    if (last) yield last;
  } finally {
    // Releases the connection when the consumer stops early, stalls out, or is aborted.
    reader.cancel().catch(() => {});
  }
}

function read(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  { idleTimeoutMs, signal }: ParseAudioStreamOptions,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      idleTimeoutMs === undefined
        ? undefined
        : setTimeout(
            () => reject(new InworldError(`inworld stream stalled for ${idleTimeoutMs}ms`)),
            idleTimeoutMs,
          );
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
  });
}

function decodeLine(line: string): Uint8Array | null {
  if (!line.trim()) return null;
  const message = JSON.parse(line) as {
    result?: { audioContent?: string };
    error?: { code?: number; message?: string };
  };
  if (message.error)
    throw new InworldError(`inworld stream error ${message.error.code}: ${message.error.message}`);
  const audio = message.result?.audioContent;
  return audio ? new Uint8Array(Buffer.from(audio, "base64")) : null;
}
