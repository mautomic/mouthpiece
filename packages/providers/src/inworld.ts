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
}

export class InworldProvider implements TtsProvider {
  readonly name = "inworld";
  /** API limit is 4,000 UTF-16 units for streaming; 2,000 keeps chunks short for latency. */
  readonly maxCharsPerRequest = 2000;
  readonly pricePerMillionChars: number;

  constructor(private readonly opts: InworldOptions) {
    this.pricePerMillionChars = opts.model.endsWith("-flash") ? 15 : 25;
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
    return { format: "mp3", chunks: parseAudioStream(response.body) };
  }
}

/** Inworld streams NDJSON: {"result":{"audioContent":"<base64>"}} per line; errors can arrive mid-stream. */
export async function* parseAudioStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
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
