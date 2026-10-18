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

/** What an event asks for its label: "always" speaks it every time, "auto" only when 2+ conversations are active. */
export const ANNOUNCES = ["always", "auto"] as const;
export type Announce = (typeof ANNOUNCES)[number];

/** A source profile's override of the event's announce request. */
export const ANNOUNCE_SETTINGS = ["never", "auto", "always"] as const;
export type AnnounceSetting = (typeof ANNOUNCE_SETTINGS)[number];

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
  /** Speak `text` as given: never summarized, whatever the mode or length. Mute and cleaning still apply. */
  verbatim?: boolean;
  /** "always": speak the label before every item; "auto" (default): only when 2+ conversations are active. */
  announce?: Announce;
  /** Where a reply to this event goes (PRD §13); a bad route is dropped, never refused. */
  reply?: ReplyRoute;
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
  verbatim: boolean;
  announce: Announce;
  reply: ReplyRoute | undefined;
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

/** POST /v1/shutdown: the daemon stops once this reply is sent (the menubar's Quit). */
export interface ShutdownResponse {
  stopping: true;
}

/** GET /v1/settings, and the reply to POST /v1/settings: what the menubar's Settings menu shows. */
export interface SettingsResponse {
  /** `provider.chain`, in order. */
  chain: string[];
  /** The local Kokoro voice (`[provider.kokoro]`); it is used while `kokoro` is in the chain. */
  kokoro: { voice: string; speed: number; voices: VoiceInfo[] };
}

/** POST /v1/settings: the settings to change; at least one is required. */
export interface SettingsUpdate {
  kokoro: { voice?: string; speed?: number };
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

/** How to pack sentences into chunks; see chunkText's options of the same names. */
export interface ChunkPacking {
  /** The first chunk is packed up to this many characters; absent, the first sentence goes alone. */
  firstChars?: number;
  /** Later chunks are packed up to this many characters. */
  targetChars: number;
}

/**
 * How a provider whose every chunk is a separate render (a local model) wants text chunked. The
 * speaker picks by its player.
 */
export interface ChunkHint {
  /** For a player with a break between clips (afplay): fewer, longer chunks. */
  withBreaks: ChunkPacking;
  /** For a gap-free player: short chunks, so speech starts on the first sentence. */
  gapless: ChunkPacking;
}

export interface TtsProvider {
  readonly name: string;
  readonly maxCharsPerRequest: number;
  readonly pricePerMillionChars: number;
  /** Absent for providers that stream audio (cloud voices) or render fast (`say`). */
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
  /** True when consecutive clips play back to back with no break; the speaker chunks text for it. */
  readonly gapless?: boolean;
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

/** Terminal hosts a reply can be typed into (PRD §13). */
export const REPLY_VIAS = ["orca"] as const;
export type ReplyVia = (typeof REPLY_VIAS)[number];

/** Where a reply goes: a terminal (`target`) on a host (`via`) running a program (`agent`, opaque). */
export interface ReplyRoute {
  via: ReplyVia;
  target: string;
  agent: string;
}

export const INBOX_STATES = ["waiting", "busy", "sending", "typed"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

/** GET /v1/inbox: the latest response of one conversation. */
export interface InboxEntry {
  id: string;
  source: string;
  conversationId: string;
  label?: string;
  text: string;
  /** The spoken summary, once ready; absent when the response is spoken in full (short, or mode full). */
  summary?: string;
  at: number;
  alert?: { text: string; at: number };
  route?: ReplyRoute;
  state: InboxState;
  /** When a reply was last sent from here; its text is never returned. */
  reply?: { at: number };
}

export interface InboxResponse {
  /** `[reply] enabled`. */
  enabled: boolean;
  /** Newest first. */
  entries: InboxEntry[];
}

/** POST /v1/inbox/dismiss: one entry by id, or `all: true` (every entry without a reply in flight). */
export interface InboxDismissRequest {
  id?: string;
  all?: true;
}

export interface InboxDismissResponse {
  dismissed: number;
}

export interface ReplyRequest {
  id: string;
  text: string;
}

export interface ReplySubmitRequest {
  id: string;
}

/** 202 from POST /v1/reply and /v1/reply/submit. */
export interface ReplyResponse {
  /** `submitted`: a turn start was observed. `typed`: the text is at the prompt, not submitted. */
  status: "submitted" | "typed";
}

export const REPLY_REFUSALS = [
  "invalid",
  "disabled",
  "busy",
  "newer",
  "in-flight",
  "not-typed",
  "draft",
  "not-idle",
  "not-agent",
  "unverified",
  "gone",
  "too-long",
  "no-route",
  "send-failed",
] as const;
export type ReplyRefusal = (typeof REPLY_REFUSALS)[number];

/** A refused reply: 400, 403, 409, 410, 413, 422 or 502. */
export interface ReplyRefusalResponse {
  error: string;
  reason: ReplyRefusal;
}

export type ReplyCheck =
  | { ok: true }
  | { ok: false; reason: "gone" | "not-agent" | "not-idle" | "draft" | "unverified" };

/** Types replies into a terminal host (PRD §13). Implementations live in adapters. */
export interface ReplyDriver {
  readonly via: string;
  /** Is the terminal still `route.agent`, idle, with an empty prompt (or one starting with `typed`)? */
  check(route: ReplyRoute, typed?: string): Promise<ReplyCheck>;
  /** Types `text` (empty: Enter alone), then Enter. `submitted` only when the host saw a turn start. */
  send(route: ReplyRoute, text: string): Promise<{ submitted: boolean }>;
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
