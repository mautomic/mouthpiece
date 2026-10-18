/**
 * Mouthpiece v1 contracts. Changes must be additive and mirrored in docs/api.md.
 * Nothing here may reference a specific source (FR-13).
 */

export const KINDS = ["response", "alert", "info"] as const;
export type Kind = (typeof KINDS)[number];

export const MODES = ["summary", "full", "off"] as const;
export type Mode = (typeof MODES)[number];

export const FORMATS = ["markdown", "plain"] as const;
export type Format = (typeof FORMATS)[number];

export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Generic event envelope accepted by POST /v1/speak (PRD §8.3). */
export interface SpeakEvent {
  text: string;
  source: string;
  conversationId?: string;
  label?: string;
  kind?: Kind;
  priority?: Priority;
  mode?: Mode;
  format?: Format;
  /** Provider voice for this event; overrides the per-label map and the provider default (≤ 100 chars). */
  voice?: string;
}

/** A SpeakEvent after validation, with defaults applied. */
export interface NormalizedSpeakEvent {
  text: string;
  source: string;
  conversationId: string;
  label: string | undefined;
  kind: Kind;
  priority: Priority;
  mode: Mode | undefined;
  format: Format;
  voice: string | undefined;
}

export type SpeakResponse = { id: string } | { id: null; skipped: string };

export interface InterruptRequest {
  source: string;
  /** Omitted: interrupt every conversation of this source. */
  conversationId?: string;
}

export interface InterruptResult {
  stopped: boolean;
  dropped: number;
}

export interface HealthResponse {
  ok: true;
  version: string;
  provider: string;
  queueDepth: number;
}

/** GET /v1/status (US-018): what the daemon is doing right now. */
export interface StatusResponse {
  version: string;
  /** True while an item is playing (false while paused). */
  speaking: boolean;
  /** True while any pause reason is active. */
  paused: boolean;
  /** Active pause reasons, e.g. `["mic"]`. */
  pauseReasons: string[];
  /** Effective global mode (ModeState.default). */
  mode: Mode;
  queueDepth: number;
  /** First provider in the chain. */
  provider: string;
  /** The item playing (or paused mid-item); null when idle. */
  current: { source: string; label?: string } | null;
  /** Why the config file could not be loaded; absent once it loads. The daemon keeps the last good config. */
  configError?: string;
}

/** POST /v1/pause and POST /v1/resume (US-022). */
export interface PauseRequest {
  /** `^[a-z][a-z0-9-]{0,31}$`, e.g. `mic`, `user`. */
  reason: string;
}

export interface PauseResponse {
  paused: boolean;
  pauseReasons: string[];
}

export type AudioFormat = "aiff" | "mp3" | "wav";

export interface AudioClip {
  format: AudioFormat;
  chunks: AsyncIterable<Uint8Array>;
  /** True when served from the audio cache. */
  cached?: boolean;
}

export interface SynthesizeOptions {
  voice?: string;
  signal?: AbortSignal;
  /** Attribution for usage metering (the event's source). */
  tag?: string;
  /** The event's label (e.g. a project name); selects a per-label voice from `[voices.<provider>]`. */
  label?: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language?: string;
}

/** Usage as reported by the provider itself, for providers with a usage API. */
export interface ProviderUsage {
  usedChars: number;
  limitChars: number;
  /** ISO 8601. */
  resetsAt?: string;
}

/**
 * How to chunk text for a provider that renders a whole request before any audio plays (a local
 * model), so speech starts soon and each chunk renders while the previous one plays.
 */
export interface ChunkHint {
  /** A first sentence longer than this is split at a clause break (`,` `;` `:` or a spaced dash). */
  firstChars: number;
  /** Later sentences are packed into chunks of about this many characters. */
  targetChars: number;
}

export interface TtsProvider {
  readonly name: string;
  readonly maxCharsPerRequest: number;
  readonly pricePerMillionChars: number;
  /** Absent for providers that stream audio as they render (cloud voices, `say`). */
  readonly chunking?: ChunkHint;
  /** Configured settings that change the audio (e.g. default voice and model). Audio caches key on it. */
  readonly cacheKey?: string;
  /** Resolves once audio starts arriving; chunks stream afterwards. Rejects on failure to start. */
  synthesize(text: string, opts?: SynthesizeOptions): Promise<AudioClip>;
  /** Voices this provider offers. */
  listVoices?(): Promise<VoiceInfo[]>;
  /** Usage reported by the provider for its current billing period; undefined when unavailable. */
  usageStatus?(): Promise<ProviderUsage | undefined>;
}

export interface Player {
  /** Resolves when playback finishes or `signal` aborts. Rejects if the clip cannot be played. */
  play(clip: AudioClip, signal: AbortSignal): Promise<void>;
}

/** Phase 2 (US-009). */
export interface Summarizer {
  readonly name: string;
  summarize(text: string, opts: { source: string; signal?: AbortSignal }): Promise<string>;
}

/** Future (PRD §12): send text back into a source's conversation. */
export interface ConversationDriver {
  readonly source: string;
  send(conversationId: string, text: string): Promise<void>;
}

export type Logger = (record: Record<string, unknown>) => void;

export interface ModeRequest {
  /** Exactly one of mode, toggle, clear. */
  mode?: Mode;
  /** summary <-> full; off -> summary. */
  toggle?: boolean;
  /** Remove the runtime override at this scope. */
  clear?: boolean;
  /** Scope. Omitted: global. Source only: that source. Plus conversationId: that conversation. */
  source?: string;
  conversationId?: string;
}

export interface ModeOverride {
  source: string;
  conversationId?: string;
  mode: Mode;
}

export interface ModeState {
  /** Effective global mode (runtime override, else config). */
  default: Mode;
  overrides: ModeOverride[];
}

export interface ReplayRequest {
  full?: boolean;
}

export interface ReplayResponse {
  id: string | null;
}

export interface UsageRow {
  provider: string;
  source: string;
  requests: number;
  /** Billed characters (cache hits excluded). */
  chars: number;
  cacheHits: number;
  costUsd: number;
}

export interface VoicesResponse {
  /** One entry per provider; a provider whose listing failed has `voices: []` and `error`. */
  providers: { provider: string; voices: VoiceInfo[]; error?: string }[];
}

/** `ok` below `usage.warnAt`, `warn` at or above it, `exceeded` at or above 100%. */
export type QuotaLevel = "ok" | "warn" | "exceeded";

export interface QuotaStatus {
  provider: string;
  limitChars: number;
  usedChars: number;
  remainingChars: number;
  projectedChars: number;
  cycleStart: string;
  cycleEnd: string;
  level: QuotaLevel;
  /** What the provider itself reports, when it has a usage API. */
  providerReported?: ProviderUsage;
}

export interface UsageReport {
  from: string;
  to: string;
  rows: UsageRow[];
  quotas: QuotaStatus[];
  /** Present when `usage.monthlyBudgetUsd` is configured; covers the current billing cycle. */
  budget?: { limitUsd: number; spentUsd: number; projectedUsd: number; level: QuotaLevel };
  /** Summarizer calls in the report range. */
  summaries?: { calls: number; failures: number; medianMs: number | null };
}
