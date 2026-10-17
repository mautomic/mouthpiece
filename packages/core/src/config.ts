import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MODES, type Mode } from "./contracts.ts";
import { isRecord } from "./guards.ts";
import type { Env } from "./home.ts";

export interface Config {
  provider: {
    chain: string[];
    say: { voice?: string };
    inworld: { model: string; voice: string };
  };
  filter: { minChars: number; trivial: string[] };
  queue: { expireAfterMs: number; labelWindowMs: number };
  fallback: { firstByteTimeoutMs: number };
  modes: { default: Mode };
  profiles: Record<string, { mode?: Mode }>;
  summarizer: {
    backend: "claude-cli" | "none";
    command: string;
    model: string;
    timeoutMs: number;
    thresholdChars: number;
    maxChars: number;
  };
  history: { maxItems: number; maxAgeMs: number };
  cache: { maxBytes: number };
  usage: { resetDay: number; quotas: Record<string, { chars: number }> };
  alerts: { dedupeWindowMs: number };
  hotkeys: { enabled: boolean; stop: string; skip: string; replay: string; toggleMode: string };
}

export const DEFAULT_CONFIG: Config = {
  provider: {
    chain: ["say"],
    say: {},
    inworld: { model: "inworld-tts-2-flash", voice: "Ashley" },
  },
  filter: { minChars: 20, trivial: ["done", "ok", "okay", "got it", "sounds good"] },
  queue: { expireAfterMs: 5 * 60_000, labelWindowMs: 10 * 60_000 },
  fallback: { firstByteTimeoutMs: 3000 },
  modes: { default: "summary" },
  profiles: {},
  summarizer: {
    backend: "claude-cli",
    command: "claude",
    model: "haiku",
    timeoutMs: 6000,
    thresholdChars: 300,
    maxChars: 350,
  },
  history: { maxItems: 100, maxAgeMs: 24 * 60 * 60_000 },
  cache: { maxBytes: 200 * 1024 * 1024 },
  usage: { resetDay: 1, quotas: {} },
  alerts: { dedupeWindowMs: 60_000 },
  hotkeys: {
    enabled: true,
    stop: "ctrl+alt+s",
    skip: "ctrl+alt+n",
    replay: "ctrl+alt+r",
    toggleMode: "ctrl+alt+m",
  },
};

export class ConfigError extends Error {}

export function configPath(env: Env = process.env): string {
  return env.MOUTHPIECE_CONFIG || join(homedir(), ".config", "mouthpiece", "config.toml");
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: invalid TOML: ${(error as Error).message}`);
  }
  try {
    return resolveConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${path}: ${error.message}`);
    throw error;
  }
}

export function resolveConfig(raw: unknown, base: Config = DEFAULT_CONFIG): Config {
  const root = table(raw, "config");
  const provider = table(root.provider, "provider");
  const say = table(provider.say, "provider.say");
  const inworld = table(provider.inworld, "provider.inworld");
  const filter = table(root.filter, "filter");
  const queue = table(root.queue, "queue");
  const fallback = table(root.fallback, "fallback");
  const modes = table(root.modes, "modes");
  const summarizer = table(root.summarizer, "summarizer");
  const history = table(root.history, "history");
  const cache = table(root.cache, "cache");
  const usage = table(root.usage, "usage");
  const alerts = table(root.alerts, "alerts");
  const hotkeys = table(root.hotkeys, "hotkeys");
  return structuredClone({
    provider: {
      chain: optional(provider.chain, "provider.chain", nonEmptyStringList) ?? base.provider.chain,
      say: {
        voice: optional(say.voice, "provider.say.voice", nonEmptyString) ?? base.provider.say.voice,
      },
      inworld: {
        model:
          optional(inworld.model, "provider.inworld.model", nonEmptyString) ??
          base.provider.inworld.model,
        voice:
          optional(inworld.voice, "provider.inworld.voice", nonEmptyString) ??
          base.provider.inworld.voice,
      },
    },
    filter: {
      minChars:
        optional(filter.minChars, "filter.minChars", nonNegativeInt) ?? base.filter.minChars,
      trivial: optional(filter.trivial, "filter.trivial", stringList) ?? base.filter.trivial,
    },
    queue: {
      expireAfterMs:
        optional(queue.expireAfterMs, "queue.expireAfterMs", positiveInt) ??
        base.queue.expireAfterMs,
      labelWindowMs:
        optional(queue.labelWindowMs, "queue.labelWindowMs", positiveInt) ??
        base.queue.labelWindowMs,
    },
    fallback: {
      firstByteTimeoutMs:
        optional(fallback.firstByteTimeoutMs, "fallback.firstByteTimeoutMs", positiveInt) ??
        base.fallback.firstByteTimeoutMs,
    },
    modes: {
      default: optional(modes.default, "modes.default", oneOf(MODES)) ?? base.modes.default,
    },
    profiles: resolveProfiles(root.profiles, base.profiles),
    summarizer: {
      backend:
        optional(
          summarizer.backend,
          "summarizer.backend",
          oneOf(["claude-cli", "none"] as const),
        ) ?? base.summarizer.backend,
      command:
        optional(summarizer.command, "summarizer.command", nonEmptyString) ??
        base.summarizer.command,
      model:
        optional(summarizer.model, "summarizer.model", nonEmptyString) ?? base.summarizer.model,
      timeoutMs:
        optional(summarizer.timeoutMs, "summarizer.timeoutMs", positiveInt) ??
        base.summarizer.timeoutMs,
      thresholdChars:
        optional(summarizer.thresholdChars, "summarizer.thresholdChars", nonNegativeInt) ??
        base.summarizer.thresholdChars,
      maxChars:
        optional(summarizer.maxChars, "summarizer.maxChars", positiveInt) ??
        base.summarizer.maxChars,
    },
    history: {
      maxItems:
        optional(history.maxItems, "history.maxItems", positiveInt) ?? base.history.maxItems,
      maxAgeMs:
        optional(history.maxAgeMs, "history.maxAgeMs", positiveInt) ?? base.history.maxAgeMs,
    },
    cache: {
      maxBytes: optional(cache.maxBytes, "cache.maxBytes", nonNegativeInt) ?? base.cache.maxBytes,
    },
    usage: {
      resetDay: optional(usage.resetDay, "usage.resetDay", dayOfMonth) ?? base.usage.resetDay,
      quotas: resolveQuotas(usage.quotas, base.usage.quotas),
    },
    alerts: {
      dedupeWindowMs:
        optional(alerts.dedupeWindowMs, "alerts.dedupeWindowMs", nonNegativeInt) ??
        base.alerts.dedupeWindowMs,
    },
    hotkeys: {
      enabled: optional(hotkeys.enabled, "hotkeys.enabled", bool) ?? base.hotkeys.enabled,
      stop: optional(hotkeys.stop, "hotkeys.stop", nonEmptyString) ?? base.hotkeys.stop,
      skip: optional(hotkeys.skip, "hotkeys.skip", nonEmptyString) ?? base.hotkeys.skip,
      replay: optional(hotkeys.replay, "hotkeys.replay", nonEmptyString) ?? base.hotkeys.replay,
      toggleMode:
        optional(hotkeys.toggleMode, "hotkeys.toggleMode", nonEmptyString) ??
        base.hotkeys.toggleMode,
    },
  });
}

function table(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`${name} must be a table`);
  return value;
}

function optional<T>(
  value: unknown,
  name: string,
  parse: (value: unknown, name: string) => T,
): T | undefined {
  return value === undefined ? undefined : parse(value, name);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "")
    throw new ConfigError(`${name} must be a non-empty string`);
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(`${name} must be a list of strings`);
  }
  return value;
}

function nonEmptyStringList(value: unknown, name: string): string[] {
  const list = stringList(value, name);
  if (list.length === 0 || list.some((v) => v === ""))
    throw new ConfigError(`${name} must be a non-empty list of names`);
  return list;
}

function nonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInt(value: unknown, name: string): number {
  const n = nonNegativeInt(value, name);
  if (n === 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

function oneOf<T extends string>(allowed: readonly T[]) {
  return (value: unknown, name: string): T => {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      throw new ConfigError(`${name} must be one of: ${allowed.join(", ")}`);
    }
    return value as T;
  };
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${name} must be true or false`);
  return value;
}

function dayOfMonth(value: unknown, name: string): number {
  const day = positiveInt(value, name);
  if (day > 28) throw new ConfigError(`${name} must be between 1 and 28`);
  return day;
}

function resolveProfiles(raw: unknown, base: Config["profiles"]): Config["profiles"] {
  if (raw === undefined) return base;
  const out: Config["profiles"] = {};
  for (const [source, value] of Object.entries(table(raw, "profiles"))) {
    const profile = table(value, `profiles.${source}`);
    out[source] = { mode: optional(profile.mode, `profiles.${source}.mode`, oneOf(MODES)) };
  }
  return out;
}

function resolveQuotas(raw: unknown, base: Config["usage"]["quotas"]): Config["usage"]["quotas"] {
  if (raw === undefined) return base;
  const out: Config["usage"]["quotas"] = {};
  for (const [provider, value] of Object.entries(table(raw, "usage.quotas"))) {
    const quota = table(value, `usage.quotas.${provider}`);
    out[provider] = { chars: positiveInt(quota.chars, `usage.quotas.${provider}.chars`) };
  }
  return out;
}
