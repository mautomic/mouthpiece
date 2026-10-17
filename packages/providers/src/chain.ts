import type { Config, Env, Logger, TtsProvider } from "@mouthpiece/core";
import { FallbackProvider } from "./fallback.ts";
import { InworldProvider } from "./inworld.ts";
import { SayProvider } from "./say.ts";

export interface ChainDeps {
  env: Env;
  tmpDir: string;
  log: Logger;
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
        const apiKey = deps.env.INWORLD_API_KEY;
        if (!apiKey) {
          deps.log({
            level: "warn",
            msg: "provider_skipped",
            provider: "inworld",
            reason: "INWORLD_API_KEY not set",
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
  if (providers.length === 0) providers.push(say());
  return new FallbackProvider(providers, {
    firstByteTimeoutMs: config.fallback.firstByteTimeoutMs,
    onFallback: (from, error) =>
      deps.log({ level: "warn", msg: "provider_fallback", provider: from, error: String(error) }),
  });
}
