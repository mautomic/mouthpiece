import type {
  AudioClip,
  ChunkHint,
  ProviderUsage,
  SynthesizeOptions,
  TtsProvider,
  VoiceInfo,
} from "@mouthpiece/core";

/**
 * Picks a configured source or label voice when the event names no voice itself. Selection order:
 * the event's voice, source's mapped voice, label's mapped voice, then the provider's configured
 * default (US-015).
 */
export class VoiceMapProvider implements TtsProvider {
  readonly name: string;
  readonly maxCharsPerRequest: number;
  readonly pricePerMillionChars: number;
  readonly cacheKey: string | undefined;
  readonly chunking: ChunkHint | undefined;
  readonly listVoices?: () => Promise<VoiceInfo[]>;
  readonly usageStatus?: () => Promise<ProviderUsage | undefined>;

  constructor(
    private readonly inner: TtsProvider,
    private readonly labelMap: Record<string, string>,
    private readonly sourceMap: Record<string, string> = {},
  ) {
    this.name = inner.name;
    this.maxCharsPerRequest = inner.maxCharsPerRequest;
    this.pricePerMillionChars = inner.pricePerMillionChars;
    this.cacheKey = inner.cacheKey;
    this.chunking = inner.chunking;
    // Present only when the inner provider has them, so callers can tell "unsupported" apart.
    if (inner.listVoices) this.listVoices = inner.listVoices.bind(inner);
    if (inner.usageStatus) this.usageStatus = inner.usageStatus.bind(inner);
  }

  synthesize(text: string, opts: SynthesizeOptions = {}): Promise<AudioClip> {
    if (opts.voice !== undefined) return this.inner.synthesize(text, opts);
    if (opts.source !== undefined && Object.hasOwn(this.sourceMap, opts.source))
      return this.inner.synthesize(text, { ...opts, voice: this.sourceMap[opts.source] });
    if (opts.label !== undefined && Object.hasOwn(this.labelMap, opts.label))
      return this.inner.synthesize(text, { ...opts, voice: this.labelMap[opts.label] });
    return this.inner.synthesize(text, opts);
  }
}
