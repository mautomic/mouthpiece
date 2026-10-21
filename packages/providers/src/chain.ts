import type { Config, Env, Logger, TtsProvider } from "@mouthpiece/core";
import { DeepgramProvider } from "./deepgram.ts";
import { ElevenLabsProvider } from "./elevenlabs.ts";
import { FallbackProvider } from "./fallback.ts";
import { ProviderHttpError } from "./http.ts";
import { InworldProvider } from "./inworld.ts";
import { isKokoroInstalled, type KokoroLoader, KokoroProvider, kokoroTimeoutMs } from "./kokoro.ts";
import { processKokoroLoader } from "./kokoro-process.ts";
import { OpenAIProvider } from "./openai.ts";
import { SayProvider } from "./say.ts";
import { VoiceMapProvider } from "./voice-map.ts";

/** Providers that need an API key (env `<NAME>_API_KEY` or the Keychain account `<name>`). */
export const PAID_PROVIDERS = ["inworld", "elevenlabs", "deepgram", "openai"] as const;
export type PaidProviderName = (typeof PAID_PROVIDERS)[number];

export interface ChainDeps {
  env: Env;
  tmpDir: string;
  log: Logger;
  /** Keys resolved outside the env (e.g. the Keychain), by provider name; env vars take precedence. */
  secrets?: Record<string, string | undefined>;
  /** Applied to each provider individually (caching, metering). */
  wrap?: (p: TtsProvider) => TtsProvider;
  /** Mouthpiece home; Kokoro is installed under `<home>/kokoro`. Without it, Kokoro is skipped. */
  home?: string;
  /**
   * Replaces `processKokoroLoader(home)` (a test seam, or a loader the caller shares across chains
   * so a config reload doesn't start a second host process).
   */
  kokoroLoader?: KokoroLoader;
  /** Clock for rate-limiting the provider_fallback log. Default Date.now. */
  now?: () => number;
}

/** A provider that keeps failing (e.g. every chunk) logs provider_fallback at most this often. */
export const FALLBACK_LOG_INTERVAL_MS = 60_000;

/**
 * Builds the configured chain's providers in order, unwrapped. Paid providers without a key, and
 * Kokoro when it isn't installed, are skipped with a warning; the list always ends in `say` (FR-8).
 */
export function createProviders(config: Config, deps: ChainDeps): TtsProvider[] {
  const say = () =>
    new SayProvider({ tmpDir: deps.tmpDir, voice: config.provider.say.voice, log: deps.log });
  const providers: TtsProvider[] = [];
  for (const name of config.provider.chain) {
    if (name === "say") {
      providers.push(say());
      continue;
    }
    if (name === "kokoro") {
      const kokoro = createKokoro(config, deps);
      if (kokoro) providers.push(kokoro);
      continue;
    }
    if (!isPaid(name)) throw new Error(`unknown provider: ${name}`);
    const envVar = `${name.toUpperCase()}_API_KEY`;
    const apiKey = deps.env[envVar] || deps.secrets?.[name];
    if (!apiKey) {
      deps.log({
        level: "warn",
        msg: "provider_skipped",
        provider: name,
        reason: `no ${envVar} or Keychain entry`,
      });
      continue;
    }
    providers.push(createPaid(name, apiKey, config));
  }
  // FR-8: the chain always ends in macOS say (also bounds a trailing paid provider by the timeout).
  if (providers.at(-1)?.name !== "say") providers.push(say());
  return providers;
}

/** US-019: free and keyless, but only usable after `mouthpiece kokoro install`. */
function createKokoro(config: Config, deps: ChainDeps): KokoroProvider | undefined {
  if (deps.home === undefined || !isKokoroInstalled(deps.home)) {
    deps.log({
      level: "warn",
      msg: "provider_skipped",
      provider: "kokoro",
      reason: "not installed; run mouthpiece kokoro install",
    });
    return undefined;
  }
  return new KokoroProvider({
    voice: config.provider.kokoro.voice,
    speed: config.provider.kokoro.speed,
    load: deps.kokoroLoader ?? processKokoroLoader(deps.home, { log: deps.log }),
    log: deps.log,
  });
}

function isPaid(name: string): name is PaidProviderName {
  return (PAID_PROVIDERS as readonly string[]).includes(name);
}

function createPaid(name: PaidProviderName, apiKey: string, config: Config): TtsProvider {
  switch (name) {
    case "inworld":
      return new InworldProvider({ apiKey, ...config.provider.inworld });
    case "elevenlabs":
      return new ElevenLabsProvider({ apiKey, ...config.provider.elevenlabs });
    case "deepgram":
      return new DeepgramProvider({ apiKey, ...config.provider.deepgram });
    case "openai":
      return new OpenAIProvider({ apiKey, ...config.provider.openai });
  }
}

/**
 * Wraps each provider (`deps.wrap`, then the per-source and per-label voice maps outermost so
 * caches key on the mapped voice) and chains them with fallback (FR-8).
 */
export function chainProviders(
  providers: readonly TtsProvider[],
  config: Config,
  deps: Pick<ChainDeps, "log" | "wrap" | "now">,
): FallbackProvider {
  const wrap = deps.wrap ?? ((p: TtsProvider) => p);
  return new FallbackProvider(
    providers.map(
      (p) =>
        new VoiceMapProvider(
          wrap(p),
          config.voices[p.name] ?? {},
          config.sourceVoices[p.name] ?? {},
        ),
    ),
    {
      firstByteTimeoutMs: config.fallback.firstByteTimeoutMs,
      timeoutFor: (name, text) =>
        name === "kokoro"
          ? kokoroTimeoutMs(text, config.fallback.firstByteTimeoutMs)
          : config.fallback.firstByteTimeoutMs,
      onFallback: fallbackLogger(deps.log, deps.now ?? Date.now),
    },
  );
}

/**
 * Logs provider_fallback once per provider and kind of error per FALLBACK_LOG_INTERVAL_MS; the next
 * log of that kind carries how many were suppressed in between. A different error from the same
 * provider is logged at once. The fallback itself still happens for every chunk.
 */
function fallbackLogger(log: Logger, now: () => number): (from: string, error: unknown) => void {
  const last = new Map<string, { at: number; suppressed: number }>();
  return (from, error) => {
    const t = now();
    const key = `${from}\0${errorKind(error)}`;
    const seen = last.get(key);
    if (seen && t - seen.at < FALLBACK_LOG_INTERVAL_MS) {
      seen.suppressed++;
      return;
    }
    if (last.size >= 256) {
      // Bounded: forget kinds that are past their window.
      for (const [k, v] of last) if (t - v.at >= FALLBACK_LOG_INTERVAL_MS) last.delete(k);
    }
    last.set(key, { at: t, suppressed: 0 });
    log({
      level: "warn",
      msg: "provider_fallback",
      provider: from,
      error: String(error),
      ...(seen?.suppressed ? { suppressed: seen.suppressed } : {}),
    });
  };
}

/**
 * An error's kind for rate limiting: its message with ids and numbers masked (timeouts, exit codes
 * and request ids vary between otherwise identical failures), cut to 80 characters. An HTTP status
 * is kept, so a 401 and a 429 with the same body are different kinds.
 */
function errorKind(error: unknown): string {
  const kind = String(error)
    .replace(/\b(?=[0-9a-f-]*\d)[0-9a-f-]{8,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return error instanceof ProviderHttpError ? `${error.status} ${kind}` : kind;
}

export function createProviderChain(config: Config, deps: ChainDeps): FallbackProvider {
  return chainProviders(createProviders(config, deps), config, deps);
}
