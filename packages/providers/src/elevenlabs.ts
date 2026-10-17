import type {
  AudioClip,
  ProviderUsage,
  SynthesizeOptions,
  TtsProvider,
  VoiceInfo,
} from "@mouthpiece/core";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, getJson, streamingClip } from "./http.ts";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export interface ElevenLabsOptions {
  apiKey: string;
  /** e.g. `eleven_flash_v2_5`. */
  model: string;
  /** Voice id, e.g. `JBFqnCBsd6RMkjVDRZzb` (George). */
  voice: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Fail the stream if no bytes arrive for this long. Default 10,000 ms. */
  streamIdleTimeoutMs?: number;
}

export class ElevenLabsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  /** Flash allows 40k chars; 2,000 keeps chunks short for latency. */
  readonly maxCharsPerRequest = 2000;
  readonly pricePerMillionChars = 40;
  readonly cacheKey: string;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.cacheKey = `${opts.voice}\u0000${opts.model}`;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    const voice = encodeURIComponent(options.voice ?? this.opts.voice);
    const res = await this.fetch(
      `${this.baseUrl}/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": this.opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: this.opts.model }),
        signal: options.signal,
      },
    );
    return streamingClip(res, {
      provider: this.name,
      idleTimeoutMs: this.opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      signal: options.signal,
    });
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const body = (await getJson(this.fetch, this.name, `${this.baseUrl}/v2/voices?page_size=100`, {
      "xi-api-key": this.opts.apiKey,
    })) as {
      voices?: { voice_id: string; name: string; verified_languages?: { language?: string }[] }[];
    };
    return (body.voices ?? []).map((v) => {
      const language = v.verified_languages?.[0]?.language;
      return language
        ? { id: v.voice_id, name: v.name, language }
        : { id: v.voice_id, name: v.name };
    });
  }

  /** Character usage for the current billing period; undefined when it can't be read. */
  async usageStatus(): Promise<ProviderUsage | undefined> {
    try {
      const body = (await getJson(this.fetch, this.name, `${this.baseUrl}/v1/user/subscription`, {
        "xi-api-key": this.opts.apiKey,
      })) as {
        character_count?: unknown;
        character_limit?: unknown;
        next_character_count_reset_unix?: unknown;
      };
      if (typeof body.character_count !== "number" || typeof body.character_limit !== "number")
        return undefined;
      const reset = body.next_character_count_reset_unix;
      return {
        usedChars: body.character_count,
        limitChars: body.character_limit,
        ...(typeof reset === "number" ? { resetsAt: new Date(reset * 1000).toISOString() } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private get baseUrl(): string {
    return this.opts.baseUrl ?? ELEVENLABS_BASE_URL;
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }
}
