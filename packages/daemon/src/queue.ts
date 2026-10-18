import {
  DEFAULT_CONFIG,
  type InterruptResult,
  type NormalizedSpeakEvent,
  type PauseResponse,
} from "@mouthpiece/core";

export interface QueueItem {
  readonly id: string;
  readonly event: NormalizedSpeakEvent;
  readonly enqueuedAt: number;
}

export interface PlayContext {
  /**
   * True when the event is labeled and more than one conversation (daemon notices aside) was
   * active within labelWindowMs (US-006). A resumed item keeps the decision it started with.
   */
  announceLabel: boolean;
  signal: AbortSignal;
  /** The chunk to start from: 0, or the chunk a pause interrupted (US-022). */
  startChunk: number;
  /** Call before playing chunk `index`, so a pause can resume from it. */
  onChunk(index: number): void;
}

/** The source of the daemon's own notices (e.g. quota), which are not conversations. */
export const NOTICE_SOURCE = "mouthpiece";

export type PlayFn = (item: QueueItem, ctx: PlayContext) => Promise<void>;

/** Timer seam for pause expiry; the default uses unref'd `setTimeout`. */
export interface QueueTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** setTimeout's largest delay (2^31 - 1 ms); anything above it fires immediately. */
const MAX_TIMER_MS = 2_147_483_647;

const DEFAULT_TIMERS: QueueTimers = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.(); // never keeps a process alive on its own
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SpeechQueueOptions {
  play: PlayFn;
  expireAfterMs: number;
  labelWindowMs: number;
  /** A pause reason older than this expires, so a lost resume cannot mute speech forever. */
  maxPauseMs?: number;
  now?: () => number;
  /** Test seam: schedules the eager pause expiry. */
  timers?: QueueTimers;
  onError?: (error: unknown, item: QueueItem) => void;
}

export interface SpeechQueueSettings {
  expireAfterMs: number;
  labelWindowMs: number;
  maxPauseMs?: number;
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

const conversationKey = (e: NormalizedSpeakEvent) => `${e.source}\u0000${e.conversationId}`;

/** Where a play stands: the chunk it last reported, and whether a pause aborted it. */
interface Playing {
  item: QueueItem;
  controller: AbortController;
  announceLabel: boolean;
  chunk: number;
  pausing: boolean;
}

/** An item a pause interrupted, waiting to resume from `chunk`. */
interface Held {
  item: QueueItem;
  announceLabel: boolean;
  chunk: number;
}

/**
 * One playback at a time, system-wide (FR-5). Interrupts are scoped by source + conversation (FR-6).
 * Pausable by reason (US-022): while any reason is active nothing plays, and the item a pause
 * interrupted is held and resumed from its chunk ahead of everything queued.
 */
export class SpeechQueue {
  #pending: QueueItem[] = [];
  #current: Playing | null = null;
  #held: Held | null = null;
  #reasons = new Map<string, number>();
  #lastSeen = new Map<string, number>();
  #idleWaiters: (() => void)[] = [];
  #seq = 0;
  #expireAfterMs: number;
  #labelWindowMs: number;
  #maxPauseMs: number;
  #expiryTimer: unknown;

  constructor(private readonly opts: SpeechQueueOptions) {
    this.#expireAfterMs = opts.expireAfterMs;
    this.#labelWindowMs = opts.labelWindowMs;
    this.#maxPauseMs = opts.maxPauseMs ?? DEFAULT_CONFIG.micPause.maxPauseMs;
  }

  /** Hot reload: new expiry, label window and pause limit take effect from the next check. */
  configure(opts: SpeechQueueSettings): void {
    this.#expireAfterMs = opts.expireAfterMs;
    this.#labelWindowMs = opts.labelWindowMs;
    if (opts.maxPauseMs !== undefined) this.#maxPauseMs = opts.maxPauseMs;
    this.#armExpiry();
  }

  get depth(): number {
    return this.#pending.length;
  }

  /** The item playing; null while paused (see `held`). */
  get current(): QueueItem | null {
    return this.#current?.item ?? null;
  }

  /** The item a pause interrupted, waiting to resume; null when none. */
  get held(): QueueItem | null {
    return this.#held?.item ?? null;
  }

  /** True while an item is playing (false while paused). */
  get speaking(): boolean {
    return this.#current !== null && !this.#current.pausing;
  }

  /** True while any pause reason is active. Expires stale reasons (and resumes) first. */
  get paused(): boolean {
    return this.pauseReasons().length > 0;
  }

  /** Active pause reasons. Expires stale reasons (and resumes) first. */
  pauseReasons(): string[] {
    this.#expireReasons();
    return [...this.#reasons.keys()];
  }

  /** Adds `reason` (restarting its clock) and stops the item playing, holding it to resume later. */
  pause(reason: string): PauseResponse {
    this.#expireReasons();
    this.#reasons.set(reason, this.#now()); // an active reason keeps its entry; its clock restarts
    const current = this.#current;
    if (current && !current.controller.signal.aborted) {
      current.pausing = true;
      this.#held = {
        item: current.item,
        announceLabel: current.announceLabel,
        chunk: current.chunk,
      };
      current.controller.abort();
    }
    this.#armExpiry();
    return this.#pauseState();
  }

  /** Removes `reason`; when no reason is left, playback resumes. An unknown reason is a no-op. */
  resume(reason: string): PauseResponse {
    this.#expireReasons();
    if (this.#reasons.delete(reason) && this.#reasons.size === 0) this.#pump();
    this.#armExpiry();
    return this.#pauseState();
  }

  enqueue(event: NormalizedSpeakEvent): QueueItem {
    const now = this.#now();
    const key = conversationKey(event);
    // Every conversation counts as active (US-006), labeled or not: an approval alert from another
    // session carries its label in its text. Only the daemon's own notices are not conversations.
    if (event.source !== NOTICE_SOURCE) this.#lastSeen.set(key, now);
    this.#pending = this.#pending.filter((p) => conversationKey(p.event) !== key);
    const item: QueueItem = {
      id: `${now.toString(36)}-${(this.#seq++).toString(36)}`,
      event,
      enqueuedAt: now,
    };
    this.#pending.push(item);
    // Array.prototype.sort is stable, so FIFO order holds within a priority.
    this.#pending.sort((a, b) => PRIORITY_RANK[a.event.priority] - PRIORITY_RANK[b.event.priority]);
    this.#expireReasons();
    this.#pump();
    return item;
  }

  interrupt(source: string, conversationId?: string): InterruptResult {
    const matches = (e: NormalizedSpeakEvent) =>
      e.source === source && (conversationId === undefined || e.conversationId === conversationId);
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((p) => !matches(p.event));
    const heldStopped = this.#held !== null && matches(this.#held.item.event);
    if (heldStopped) this.#held = null;
    const current = this.#current;
    const playingStopped = current !== null && !current.pausing && matches(current.item.event);
    if (playingStopped) current.controller.abort();
    this.#settleIfIdle();
    return { stopped: heldStopped || playingStopped, dropped: before - this.#pending.length };
  }

  stopAll(): InterruptResult {
    const dropped = this.#pending.length;
    this.#pending = [];
    const heldStopped = this.#held !== null;
    this.#held = null;
    const current = this.#current;
    const playingStopped = current !== null && !current.pausing;
    current?.controller.abort();
    this.#settleIfIdle();
    return { stopped: heldStopped || playingStopped, dropped };
  }

  /** Skips the item playing, or the held item while paused. */
  skip(): boolean {
    const current = this.#current;
    if (current && !current.pausing) {
      current.controller.abort();
      return true;
    }
    if (!this.#held) return false;
    this.#held = null;
    this.#settleIfIdle();
    return true;
  }

  idle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #now(): number {
    return (this.opts.now ?? Date.now)();
  }

  #isIdle(): boolean {
    return !this.#current && !this.#held && this.#pending.length === 0;
  }

  #pauseState(): PauseResponse {
    return { paused: this.#reasons.size > 0, pauseReasons: [...this.#reasons.keys()] };
  }

  /** Drops reasons older than maxPauseMs; resumes when that empties the set. */
  #expireReasons(): void {
    if (this.#reasons.size === 0) return;
    const now = this.#now();
    let expired = false;
    for (const [reason, since] of this.#reasons) {
      if (now - since > this.#maxPauseMs) expired = this.#reasons.delete(reason);
    }
    if (!expired) return;
    if (this.#reasons.size === 0) this.#pump();
    this.#armExpiry();
  }

  /**
   * Expires pause reasons eagerly: one timer for the earliest reason's expiry, so a held item
   * resumes on time even when nothing polls the queue (e.g. no menubar). Cleared when no reason
   * is left.
   */
  #armExpiry(): void {
    const timers = this.opts.timers ?? DEFAULT_TIMERS;
    if (this.#expiryTimer !== undefined) timers.clear(this.#expiryTimer);
    this.#expiryTimer = undefined;
    if (this.#reasons.size === 0) return;
    const earliest = Math.min(...this.#reasons.values());
    // A reason expires once it is *older* than maxPauseMs, hence the + 1. Clamped to setTimeout's
    // limit (a longer delay fires at once, in a loop); an early firing just re-arms for the rest.
    const delay = Math.min(
      MAX_TIMER_MS,
      Math.max(0, earliest + this.#maxPauseMs + 1 - this.#now()),
    );
    this.#expiryTimer = timers.set(() => {
      this.#expiryTimer = undefined;
      this.#expireReasons();
      this.#armExpiry();
    }, delay);
  }

  /** Resolves `idle()` waiters once nothing is playing, held or queued. */
  #settleIfIdle(): void {
    if (this.#isIdle()) for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }

  #pump(): void {
    if (this.#current || this.#reasons.size > 0) return;
    const now = this.#now();
    this.#pending = this.#pending.filter((p) => now - p.enqueuedAt <= this.#expireAfterMs);
    // A held item resumes first and never expires: it was already playing.
    const held = this.#held;
    this.#held = null;
    const item = held?.item ?? this.#pending.shift();
    if (!item) {
      this.#settleIfIdle();
      return;
    }
    const controller = new AbortController();
    const playing: Playing = {
      item,
      controller,
      announceLabel:
        held?.announceLabel ??
        (item.event.label !== undefined && this.#activeConversations(now) > 1),
      chunk: held?.chunk ?? 0,
      pausing: false,
    };
    this.#current = playing;
    const ctx: PlayContext = {
      announceLabel: playing.announceLabel,
      signal: controller.signal,
      startChunk: playing.chunk,
      onChunk: (index) => {
        // A play winding down after an abort must not move the resume point.
        if (!controller.signal.aborted) playing.chunk = index;
      },
    };
    // Start play synchronously so the item is playing (and listening for abort) before
    // enqueue() returns; a synchronous throw becomes a rejection.
    let run: Promise<void>;
    try {
      run = this.opts.play(item, ctx);
    } catch (error) {
      run = Promise.reject(error);
    }
    void run
      .catch((error) => {
        // Aborted by skip/stop/interrupt/pause: whatever the play threw is expected.
        if (!controller.signal.aborted) this.opts.onError?.(error, item);
      })
      .finally(() => {
        this.#current = null;
        // While paused this does nothing; the held item waits for resume().
        this.#pump();
        this.#settleIfIdle();
      });
  }

  #activeConversations(now: number): number {
    let active = 0;
    for (const [key, seen] of this.#lastSeen) {
      if (now - seen <= this.#labelWindowMs) active++;
      else this.#lastSeen.delete(key);
    }
    return active;
  }
}
