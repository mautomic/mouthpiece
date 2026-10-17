import type { InterruptResult, NormalizedSpeakEvent } from "@mouthpiece/core";

export interface QueueItem {
  readonly id: string;
  readonly event: NormalizedSpeakEvent;
  readonly enqueuedAt: number;
}

export interface PlayContext {
  /**
   * True when the event is labeled and more than one conversation (daemon notices aside) was
   * active within labelWindowMs (US-006).
   */
  announceLabel: boolean;
  signal: AbortSignal;
}

/** The source of the daemon's own notices (e.g. quota), which are not conversations. */
export const NOTICE_SOURCE = "mouthpiece";

export type PlayFn = (item: QueueItem, ctx: PlayContext) => Promise<void>;

export interface SpeechQueueOptions {
  play: PlayFn;
  expireAfterMs: number;
  labelWindowMs: number;
  now?: () => number;
  onError?: (error: unknown, item: QueueItem) => void;
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

const conversationKey = (e: NormalizedSpeakEvent) => `${e.source}\u0000${e.conversationId}`;

/** One playback at a time, system-wide (FR-5). Interrupts are scoped by source + conversation (FR-6). */
export class SpeechQueue {
  #pending: QueueItem[] = [];
  #current: { item: QueueItem; controller: AbortController } | null = null;
  #lastSeen = new Map<string, number>();
  #idleWaiters: (() => void)[] = [];
  #seq = 0;
  #expireAfterMs: number;
  #labelWindowMs: number;

  constructor(private readonly opts: SpeechQueueOptions) {
    this.#expireAfterMs = opts.expireAfterMs;
    this.#labelWindowMs = opts.labelWindowMs;
  }

  /** Hot reload: new expiry and label window take effect from the next pump. */
  configure(opts: { expireAfterMs: number; labelWindowMs: number }): void {
    this.#expireAfterMs = opts.expireAfterMs;
    this.#labelWindowMs = opts.labelWindowMs;
  }

  get depth(): number {
    return this.#pending.length;
  }

  get current(): QueueItem | null {
    return this.#current?.item ?? null;
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
    this.#pump();
    return item;
  }

  interrupt(source: string, conversationId?: string): InterruptResult {
    const matches = (e: NormalizedSpeakEvent) =>
      e.source === source && (conversationId === undefined || e.conversationId === conversationId);
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((p) => !matches(p.event));
    const current = this.#current;
    const stopped = current !== null && matches(current.item.event);
    if (stopped) current.controller.abort();
    return { stopped, dropped: before - this.#pending.length };
  }

  stopAll(): InterruptResult {
    const dropped = this.#pending.length;
    this.#pending = [];
    const stopped = this.#current !== null;
    this.#current?.controller.abort();
    return { stopped, dropped };
  }

  skip(): boolean {
    if (!this.#current) return false;
    this.#current.controller.abort();
    return true;
  }

  idle(): Promise<void> {
    if (!this.#current && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #now(): number {
    return (this.opts.now ?? Date.now)();
  }

  #pump(): void {
    if (this.#current) return;
    const now = this.#now();
    this.#pending = this.#pending.filter((p) => now - p.enqueuedAt <= this.#expireAfterMs);
    const item = this.#pending.shift();
    if (!item) {
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
      return;
    }
    const controller = new AbortController();
    this.#current = { item, controller };
    const ctx: PlayContext = {
      announceLabel: item.event.label !== undefined && this.#activeConversations(now) > 1,
      signal: controller.signal,
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
        if (!controller.signal.aborted) this.opts.onError?.(error, item);
      })
      .finally(() => {
        this.#current = null;
        this.#pump();
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
