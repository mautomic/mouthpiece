import type {
  AudioClip,
  ProviderUsage,
  SynthesizeOptions,
  TtsProvider,
  VoiceInfo,
} from "@mouthpiece/core";

/**
 * Picks a per-label voice (`[voices.<provider>]`, e.g. one voice per project) when the event names
 * no voice itself. Selection order: the event's voice, then the label's mapped voice, then the
 * provider's configured default (US-015).
 */
export class VoiceMapProvider implements TtsProvider {
  readonly name: string;
  readonly maxCharsPerRequest: number;
  readonly pricePerMillionChars: number;
  readonly cacheKey: string | undefined;
  readonly listVoices?: () => Promise<VoiceInfo[]>;
  readonly usageStatus?: () => Promise<ProviderUsage | undefined>;

  constructor(
    private readonly inner: TtsProvider,
    private readonly map: Record<string, string>,
  ) {
    this.name = inner.name;
    this.maxCharsPerRequest = inner.maxCharsPerRequest;
    this.pricePerMillionChars = inner.pricePerMillionChars;
    this.cacheKey = inner.cacheKey;
    // Present only when the inner provider has them, so callers can tell "unsupported" apart.
    if (inner.listVoices) this.listVoices = inner.listVoices.bind(inner);
    if (inner.usageStatus) this.usageStatus = inner.usageStatus.bind(inner);
  }

  synthesize(text: string, opts: SynthesizeOptions = {}): Promise<AudioClip> {
    const { label } = opts;
    if (opts.voice !== undefined || label === undefined || !Object.hasOwn(this.map, label))
      return this.inner.synthesize(text, opts);
    return this.inner.synthesize(text, { ...opts, voice: this.map[label] });
  }
}
