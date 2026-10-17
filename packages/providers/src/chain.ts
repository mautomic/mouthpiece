import type { Config, Env, Logger, TtsProvider } from "@mouthpiece/core";
import { DeepgramProvider } from "./deepgram.ts";
import { ElevenLabsProvider } from "./elevenlabs.ts";
import { FallbackProvider } from "./fallback.ts";
import { InworldProvider } from "./inworld.ts";
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
}

/**
 * Builds the configured chain's providers in order, unwrapped. Paid providers without a key are
 * skipped with a warning, and the list always ends in `say` (FR-8).
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
 * Wraps each provider (`deps.wrap`, then the per-label voice map outermost so caches key on the
 * mapped voice) and chains them with fallback (FR-8).
 */
export function chainProviders(
  providers: readonly TtsProvider[],
  config: Config,
  deps: Pick<ChainDeps, "log" | "wrap">,
): FallbackProvider {
  const wrap = deps.wrap ?? ((p: TtsProvider) => p);
  return new FallbackProvider(
    providers.map((p) => new VoiceMapProvider(wrap(p), config.voices[p.name] ?? {})),
    {
      firstByteTimeoutMs: config.fallback.firstByteTimeoutMs,
      onFallback: (from, error) =>
        deps.log({ level: "warn", msg: "provider_fallback", provider: from, error: String(error) }),
    },
  );
}

export function createProviderChain(config: Config, deps: ChainDeps): FallbackProvider {
  return chainProviders(createProviders(config, deps), config, deps);
}
