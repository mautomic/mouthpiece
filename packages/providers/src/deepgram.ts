import type { AudioClip, SynthesizeOptions, TtsProvider, VoiceInfo } from "@mouthpiece/core";
import { getJson, streamingClip } from "./http.ts";

export const DEEPGRAM_BASE_URL = "https://api.deepgram.com";

export interface DeepgramOptions {
  apiKey: string;
  /** The voice is the model, e.g. `aura-2-thalia-en`. */
  model: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Fail the stream if no bytes arrive for this long. Default 10,000 ms. */
  streamIdleTimeoutMs?: number;
}

export class DeepgramProvider implements TtsProvider {
  readonly name = "deepgram";
  /** Deepgram's hard limit (413 above it). */
  readonly maxCharsPerRequest = 2000;
  readonly pricePerMillionChars = 30;
  readonly cacheKey: string;

  constructor(private readonly opts: DeepgramOptions) {
    this.cacheKey = `${opts.model}\u0000${opts.model}`;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    // A voice is a model id; anything else (e.g. another provider's voice name) is ignored.
    const model = options.voice?.startsWith("aura-") ? options.voice : this.opts.model;
    const params = new URLSearchParams({ model, encoding: "mp3", bit_rate: "48000" });
    const res = await (this.opts.fetch ?? fetch)(`${this.baseUrl}/v1/speak?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: options.signal,
    });
    return streamingClip(res, {
      provider: this.name,
      idleTimeoutMs: this.opts.streamIdleTimeoutMs,
      signal: options.signal,
    });
  }

  /** Aura-2 voices from the public model list (no auth needed). */
  async listVoices(): Promise<VoiceInfo[]> {
    const body = (await getJson(
      this.opts.fetch ?? fetch,
      this.name,
      `${this.baseUrl}/v1/models`,
    )) as { tts?: { canonical_name: string; name: string; languages?: string[] }[] };
    return (body.tts ?? [])
      .filter((m) => m.canonical_name?.startsWith("aura-2-"))
      .map((m) => {
        const language = m.languages?.[0];
        return { id: m.canonical_name, name: m.name, ...(language ? { language } : {}) };
      });
  }

  private get baseUrl(): string {
    return this.opts.baseUrl ?? DEEPGRAM_BASE_URL;
  }
}
