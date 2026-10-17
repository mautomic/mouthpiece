import type { AudioClip, SynthesizeOptions, TtsProvider } from "@mouthpiece/core";

export interface FallbackOptions {
  firstByteTimeoutMs: number;
  onFallback?: (from: string, error: unknown) => void;
}

/** Tries providers in order; a provider that errors or exceeds the first-byte timeout falls through (FR-8). */
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
    for (const provider of this.providers) {
      options.signal?.throwIfAborted();
      const attempt = new AbortController();
      const forwardAbort = () => attempt.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `${provider.name}: no audio within ${this.opts.firstByteTimeoutMs}ms`,
          );
          attempt.abort(error);
          reject(error);
        }, this.opts.firstByteTimeoutMs);
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
