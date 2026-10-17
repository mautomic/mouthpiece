import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  if (nonNegativeInt(value, name) === 0)
    throw new ConfigError(`${name} must be a positive integer`);
  return value as number;
}
