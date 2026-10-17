import type { AudioClip, SynthesizeOptions, TtsProvider, VoiceInfo } from "@mouthpiece/core";
import { streamingClip } from "./http.ts";

export const OPENAI_BASE_URL = "https://api.openai.com";

/** Every built-in voice; `marin` and `cedar` are only available on gpt-4o-mini-tts. */
export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
const MINI_TTS_ONLY = new Set<string>(["marin", "cedar"]);

export interface OpenAIOptions {
  apiKey: string;
  /** `tts-1`, `tts-1-hd` or `gpt-4o-mini-tts`. */
  model: string;
  voice: string;
  /** Speaking-style prompt; only gpt-4o-mini-tts models accept it. */
  instructions?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Fail the stream if no bytes arrive for this long. Default 10,000 ms. */
  streamIdleTimeoutMs?: number;
}

export class OpenAIProvider implements TtsProvider {
  readonly name = "openai";
  /** API limit is 4,096; 2,000 keeps chunks short for latency. */
  readonly maxCharsPerRequest = 2000;
  /** gpt-4o-mini-tts is token-billed; $15 per 1M chars is an estimate. */
  readonly pricePerMillionChars: number;
  readonly cacheKey: string;
  private readonly instructions: string | undefined;

  constructor(private readonly opts: OpenAIOptions) {
    this.pricePerMillionChars = opts.model === "tts-1-hd" ? 30 : 15;
    this.instructions = isMiniTts(opts.model) ? opts.instructions : undefined;
    this.cacheKey = `${opts.voice}\u0000${opts.model}${this.instructions ? `\u0000${this.instructions}` : ""}`;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    const res = await (this.opts.fetch ?? fetch)(
      `${this.opts.baseUrl ?? OPENAI_BASE_URL}/v1/audio/speech`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.opts.model,
          input: text,
          voice: options.voice ?? this.opts.voice,
          response_format: "mp3",
          ...(this.instructions ? { instructions: this.instructions } : {}),
        }),
        signal: options.signal,
      },
    );
    return streamingClip(res, {
      provider: this.name,
      idleTimeoutMs: this.opts.streamIdleTimeoutMs,
      signal: options.signal,
    });
  }

  /** OpenAI has no voices endpoint; the list is fixed per model. */
  async listVoices(): Promise<VoiceInfo[]> {
    const mini = isMiniTts(this.opts.model);
    return OPENAI_VOICES.filter((v) => mini || !MINI_TTS_ONLY.has(v)).map((v) => ({
      id: v,
      name: v,
    }));
  }
}

function isMiniTts(model: string): boolean {
  return model.startsWith("gpt-4o-mini-tts");
}
