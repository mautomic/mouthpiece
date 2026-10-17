import type { Config, Env, Logger, TtsProvider } from "@mouthpiece/core";
import { FallbackProvider } from "./fallback.ts";
import { InworldProvider } from "./inworld.ts";
import { SayProvider } from "./say.ts";

export interface ChainDeps {
  env: Env;
  tmpDir: string;
  log: Logger;
  /** Keys resolved outside the env (e.g. the Keychain); env vars take precedence. */
  secrets?: { inworld?: string };
  /** Applied to each provider individually (caching, metering). */
  wrap?: (p: TtsProvider) => TtsProvider;
}

export function createProviderChain(config: Config, deps: ChainDeps): FallbackProvider {
  const say = () => new SayProvider({ tmpDir: deps.tmpDir, voice: config.provider.say.voice });
  const providers: TtsProvider[] = [];
  for (const name of config.provider.chain) {
    switch (name) {
      case "say":
        providers.push(say());
        break;
      case "inworld": {
        const apiKey = deps.env.INWORLD_API_KEY ?? deps.secrets?.inworld;
        if (!apiKey) {
          deps.log({
            level: "warn",
            msg: "provider_skipped",
            provider: "inworld",
            reason: "no INWORLD_API_KEY or Keychain entry",
          });
          break;
        }
        providers.push(new InworldProvider({ apiKey, ...config.provider.inworld }));
        break;
      }
      default:
        throw new Error(`unknown provider: ${name}`);
    }
  }
  // FR-8: the chain always ends in macOS say (also bounds a trailing paid provider by the timeout).
  if (providers.at(-1)?.name !== "say") providers.push(say());
  const wrap = deps.wrap ?? ((p: TtsProvider) => p);
  return new FallbackProvider(providers.map(wrap), {
    firstByteTimeoutMs: config.fallback.firstByteTimeoutMs,
    onFallback: (from, error) =>
      deps.log({ level: "warn", msg: "provider_fallback", provider: from, error: String(error) }),
  });
}
