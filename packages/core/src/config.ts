import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ANNOUNCE_SETTINGS, type AnnounceSetting, MODES, type Mode } from "./contracts.ts";
import { isRecord } from "./guards.ts";
import type { Env } from "./home.ts";

export interface Config {
  provider: {
    chain: string[];
    say: { voice?: string };
    inworld: { model: string; voice: string };
    elevenlabs: { model: string; voice: string };
    /** Deepgram's voice is its model (e.g. `aura-2-thalia-en`). */
    deepgram: { model: string };
    openai: { model: string; voice: string; instructions?: string };
    /**
     * Local Kokoro voice (e.g. `af_heart`); installed by `mouthpiece kokoro install`. `speed` is
     * Kokoro's speaking rate, from 0.5 to 2 (1 is normal).
     */
    kokoro: { voice: string; speed: number };
  };
  /** `[voices.<provider>] "<label>" = "<voice>"`: per-label (e.g. per-project) voice for each provider. */
  voices: Record<string, Record<string, string>>;
  filter: { minChars: number; trivial: string[] };
  queue: { expireAfterMs: number; labelWindowMs: number };
  fallback: { firstByteTimeoutMs: number };
  modes: { default: Mode };
  profiles: Record<string, { mode?: Mode; announce?: AnnounceSetting }>;
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
  usage: {
    resetDay: number;
    quotas: Record<string, { chars: number }>;
    /** Fraction of a quota or budget (0 < x < 1) at which a warning is spoken. */
    warnAt: number;
    /** Optional cap on total provider cost per billing cycle. */
    monthlyBudgetUsd?: number;
  };
  alerts: { dedupeWindowMs: number };
  hotkeys: { enabled: boolean; stop: string; skip: string; replay: string; toggleMode: string };
  /** Menubar status item in the helper app (US-018). */
  menubar: { enabled: boolean };
  /** Pause speech while another app uses the microphone (US-022). */
  micPause: {
    enabled: boolean;
    /** Bundle ids whose mic use never pauses speech (e.g. `us.zoom.xos`). */
    ignoreBundleIds: string[];
    /** How long the mic must stay idle before speech resumes. */
    resumeDelayMs: number;
    /** Safety: a pause reason expires after this long (at most MAX_PAUSE_MS). */
    maxPauseMs: number;
  };
  /**
   * `auto`: the gap-free stream player (`mouthpiece-player`, built by `mouthpiece build-helper`)
   * when it is built, else afplay. `afplay`: always afplay. Read when the daemon starts.
   */
  player: { backend: PlayerBackend };
}

/** The largest `micPause.maxPauseMs`: 24 hours. */
export const MAX_PAUSE_MS = 86_400_000;

export const DEFAULT_CONFIG: Config = {
  provider: {
    chain: ["say"],
    say: {},
    inworld: { model: "inworld-tts-2-flash", voice: "Ashley" },
    elevenlabs: { model: "eleven_flash_v2_5", voice: "JBFqnCBsd6RMkjVDRZzb" },
    deepgram: { model: "aura-2-thalia-en" },
    openai: { model: "tts-1", voice: "alloy" },
    kokoro: { voice: "af_heart", speed: 1 },
  },
  voices: {},
  filter: { minChars: 20, trivial: ["done", "ok", "okay", "got it", "sounds good"] },
  queue: { expireAfterMs: 5 * 60_000, labelWindowMs: 10 * 60_000 },
  fallback: { firstByteTimeoutMs: 3000 },
  modes: { default: "summary" },
  profiles: {},
  summarizer: {
    backend: "claude-cli",
    command: "claude",
    model: "haiku",
    // Measured: haiku takes 2-8 s for a summary, longer ones for complex replies (US-009).
    timeoutMs: 12_000,
    thresholdChars: 300,
    // Room for a question, what the user must do, and the outcome of a complex reply. Past ~400
    // characters Kokoro speaks it as two clips, split between sentences.
    maxChars: 700,
  },
  history: { maxItems: 100, maxAgeMs: 24 * 60 * 60_000 },
  cache: { maxBytes: 200 * 1024 * 1024 },
  usage: { resetDay: 1, quotas: {}, warnAt: 0.8 },
  alerts: { dedupeWindowMs: 60_000 },
  hotkeys: {
    enabled: true,
    stop: "ctrl+alt+s",
    skip: "ctrl+alt+n",
    replay: "ctrl+alt+r",
    toggleMode: "ctrl+alt+m",
  },
  menubar: { enabled: true },
  micPause: { enabled: true, ignoreBundleIds: [], resumeDelayMs: 800, maxPauseMs: 600_000 },
  player: { backend: "auto" },
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
  return parseConfig(text, path);
}

/** Parses and validates config TOML; `path` only names the file in errors. */
export function parseConfig(text: string, path: string): Config {
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
  const elevenlabs = table(provider.elevenlabs, "provider.elevenlabs");
  const deepgram = table(provider.deepgram, "provider.deepgram");
  const openai = table(provider.openai, "provider.openai");
  const kokoro = table(provider.kokoro, "provider.kokoro");
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
  const menubar = table(root.menubar, "menubar");
  const micPause = table(root.micPause, "micPause");
  const player = table(root.player, "player");
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
      elevenlabs: {
        model:
          optional(elevenlabs.model, "provider.elevenlabs.model", nonEmptyString) ??
          base.provider.elevenlabs.model,
        voice:
          optional(elevenlabs.voice, "provider.elevenlabs.voice", nonEmptyString) ??
          base.provider.elevenlabs.voice,
      },
      deepgram: {
        model:
          optional(deepgram.model, "provider.deepgram.model", nonEmptyString) ??
          base.provider.deepgram.model,
      },
      openai: resolveOpenAi(openai, base.provider.openai),
      kokoro: {
        voice:
          optional(kokoro.voice, "provider.kokoro.voice", nonEmptyString) ??
          base.provider.kokoro.voice,
        speed:
          optional(kokoro.speed, "provider.kokoro.speed", kokoroSpeed) ??
          base.provider.kokoro.speed,
      },
    },
    voices: resolveVoices(root.voices, base.voices),
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
      warnAt: optional(usage.warnAt, "usage.warnAt", fraction) ?? base.usage.warnAt,
      ...optionalField(
        "monthlyBudgetUsd",
        optional(usage.monthlyBudgetUsd, "usage.monthlyBudgetUsd", positiveNumber) ??
          base.usage.monthlyBudgetUsd,
      ),
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
    menubar: {
      enabled: optional(menubar.enabled, "menubar.enabled", bool) ?? base.menubar.enabled,
    },
    micPause: {
      enabled: optional(micPause.enabled, "micPause.enabled", bool) ?? base.micPause.enabled,
      ignoreBundleIds:
        optional(micPause.ignoreBundleIds, "micPause.ignoreBundleIds", nonEmptyStrings) ??
        base.micPause.ignoreBundleIds,
      resumeDelayMs:
        optional(micPause.resumeDelayMs, "micPause.resumeDelayMs", positiveInt) ??
        base.micPause.resumeDelayMs,
      maxPauseMs:
        optional(micPause.maxPauseMs, "micPause.maxPauseMs", (v, n) =>
          atMost(positiveInt(v, n), MAX_PAUSE_MS, n),
        ) ?? base.micPause.maxPauseMs,
    },
    player: {
      backend:
        optional(player.backend, "player.backend", oneOf(PLAYER_BACKENDS)) ?? base.player.backend,
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

/** A possibly empty list of non-empty strings. */
function nonEmptyStrings(value: unknown, name: string): string[] {
  const list = stringList(value, name);
  if (list.some((v) => v === "")) throw new ConfigError(`${name} must not contain empty strings`);
  return list;
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

function atMost(value: number, max: number, name: string): number {
  if (value > max) throw new ConfigError(`${name} must be at most ${max}`);
  return value;
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number`);
  }
  return value;
}

export const PLAYER_BACKENDS = ["auto", "afplay"] as const;
export type PlayerBackend = (typeof PLAYER_BACKENDS)[number];

export const KOKORO_SPEED_MIN = 0.5;
export const KOKORO_SPEED_MAX = 2;

/** Kokoro's speaking rate: 0.5 (half speed) to 2 (double). */
function kokoroSpeed(value: unknown, name: string): number {
  if (!isKokoroSpeed(value)) {
    throw new ConfigError(
      `${name} must be a number from ${KOKORO_SPEED_MIN} to ${KOKORO_SPEED_MAX}`,
    );
  }
  return value;
}

export function isKokoroSpeed(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= KOKORO_SPEED_MIN &&
    value <= KOKORO_SPEED_MAX
  );
}

/** A number strictly between 0 and 1. */
function fraction(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ConfigError(`${name} must be a number between 0 and 1 (exclusive)`);
  }
  return value;
}

/** `{ [key]: value }` when value is defined, else `{}`, so absent optional keys stay absent. */
function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
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
    out[source] = {
      mode: optional(profile.mode, `profiles.${source}.mode`, oneOf(MODES)),
      announce: optional(profile.announce, `profiles.${source}.announce`, oneOf(ANNOUNCE_SETTINGS)),
    };
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

function resolveOpenAi(
  raw: Record<string, unknown>,
  base: Config["provider"]["openai"],
): Config["provider"]["openai"] {
  return {
    model: optional(raw.model, "provider.openai.model", nonEmptyString) ?? base.model,
    voice: optional(raw.voice, "provider.openai.voice", nonEmptyString) ?? base.voice,
    ...optionalField(
      "instructions",
      optional(raw.instructions, "provider.openai.instructions", nonEmptyString) ??
        base.instructions,
    ),
  };
}

function resolveVoices(raw: unknown, base: Config["voices"]): Config["voices"] {
  if (raw === undefined) return base;
  const out: Config["voices"] = {};
  for (const [provider, value] of Object.entries(table(raw, "voices"))) {
    if (!isRecord(value)) throw new ConfigError(`voices.${provider} must be a table`);
    const map: Record<string, string> = {};
    for (const [label, voice] of Object.entries(value)) {
      map[label] = nonEmptyString(voice, `voices.${provider}.${label}`);
    }
    out[provider] = map;
  }
  return out;
}
