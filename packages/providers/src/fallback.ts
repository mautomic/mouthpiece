import type { AudioClip, SynthesizeOptions, TtsProvider } from "@mouthpiece/core";

export interface FallbackOptions {
  firstByteTimeoutMs: number;
  /** Overrides the first-byte timeout for one provider and text (e.g. a local renderer). */
  timeoutFor?: (provider: string, text: string) => number;
  onFallback?: (from: string, error: unknown) => void;
}

/**
 * Tries providers in order; a provider that errors or exceeds the first-byte timeout falls through (FR-8).
 * The last provider has nothing to fall back to, so it gets no first-byte timeout: `say` renders the
 * whole chunk before returning audio and routinely needs longer than the timeout for long chunks.
 */
export class FallbackProvider implements TtsProvider {
  readonly name: string;
  readonly maxCharsPerRequest: number;
  readonly pricePerMillionChars: number;

  constructor(
    private readonly providers: readonly TtsProvider[],
    private readonly opts: FallbackOptions,
  ) {
    const [first] = providers;
    if (!first) throw new Error("FallbackProvider needs at least one provider");
    this.name = providers.map((p) => p.name).join(">");
    this.maxCharsPerRequest = Math.min(...providers.map((p) => p.maxCharsPerRequest));
    this.pricePerMillionChars = first.pricePerMillionChars;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    let lastError: unknown = new Error("no providers attempted");
    for (const [index, provider] of this.providers.entries()) {
      options.signal?.throwIfAborted();
      const isLast = index === this.providers.length - 1;
      const attempt = new AbortController();
      const forwardAbort = () => attempt.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        if (isLast) return;
        const ms = this.opts.timeoutFor?.(provider.name, text) ?? this.opts.firstByteTimeoutMs;
        timer = setTimeout(() => {
          const error = new Error(`${provider.name}: no audio within ${ms}ms`);
          attempt.abort(error);
          reject(error);
        }, ms);
      });
      try {
        // On success the abort link stays in place so the caller can still stop the stream.
        return await Promise.race([
          provider.synthesize(text, { ...options, signal: attempt.signal }),
          timeout,
        ]);
      } catch (error) {
        options.signal?.removeEventListener("abort", forwardAbort);
        if (options.signal?.aborted) throw error;
        lastError = error;
        this.opts.onFallback?.(provider.name, error);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}
