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
}

export interface TtsProvider {
  readonly name: string;
  readonly maxCharsPerRequest: number;
  readonly pricePerMillionChars: number;
  /** Configured settings that change the audio (e.g. default voice and model). Audio caches key on it. */
  readonly cacheKey?: string;
  /** Resolves once audio starts arriving; chunks stream afterwards. Rejects on failure to start. */
  synthesize(text: string, opts?: SynthesizeOptions): Promise<AudioClip>;
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

export interface QuotaStatus {
  provider: string;
  limitChars: number;
  usedChars: number;
  remainingChars: number;
  projectedChars: number;
  cycleStart: string;
  cycleEnd: string;
}

export interface UsageReport {
  from: string;
  to: string;
  rows: UsageRow[];
  quotas: QuotaStatus[];
}
