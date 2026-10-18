// margin-follower.ts: follow the logs of the docs Margin has recently opened (US-014). The list is
// Margin's `recent-docs.json`; anything unreadable leaves the followed set as it is.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Env } from "@mouthpiece/core";
import { createMarginParser, lastMarginSeq, marginLog } from "./margin.ts";
import { FileTailer, nodeTailFs, type TailFs, type TailMessage } from "./tailer.ts";

const DEFAULT_RESCAN_MS = 5000;
/** How much of a log's end is read to find where it stands when following begins. */
const PRIME_BYTES = 64 * 1024;

export interface MarginFollowerOptions {
  /** Follow just this doc; by default, every doc in Margin's recent list. */
  doc?: string;
  /** Where Margin's state dir is found (MARGIN_STATE_DIR, XDG_RUNTIME_DIR, HOME). */
  env?: Env;
  onMessage: (m: TailMessage) => void;
  onFollow?: (log: string) => void;
  onError?: (error: unknown) => void;
  pollMs?: number;
  /** How often the recent list is re-read (default 5 s). */
  rescanMs?: number;
  now?: () => number;
  fs?: TailFs;
}

/** Margin's state dir, in Margin's own order. */
export function marginStateDir(env: Env): string {
  if (env.MARGIN_STATE_DIR) return env.MARGIN_STATE_DIR;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "margin");
  return join(env.HOME || homedir(), ".cache", "margin");
}

/**
 * Follows each recent doc's log with its own FileTailer: an existing log from its end, a new one
 * from its start. A doc stays followed once found, even if it drops off the list.
 */
export class MarginFollower {
  private readonly fs: TailFs;
  private readonly now: () => number;
  private readonly parser = createMarginParser();
  private readonly tailers = new Map<string, FileTailer>();
  private lastScanAt: number | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private stopped = false;

  constructor(private readonly opts: MarginFollowerOptions) {
    this.fs = opts.fs ?? nodeTailFs;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    // A pass that stalls (an offline volume) must not queue more passes behind it.
    this.timer = setInterval(() => {
      if (!this.busy) void this.poll();
    }, this.opts.pollMs ?? 500);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const tailer of this.tailers.values()) tailer.stop();
  }

  /** One pass, serialized: re-read the list when due, then read every followed log. */
  poll(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      this.busy = true;
      try {
        await this.discover();
        for (const tailer of this.tailers.values()) await tailer.poll();
      } catch (error) {
        this.opts.onError?.(error);
      } finally {
        this.busy = false;
      }
    });
    return this.chain;
  }

  private async discover(): Promise<void> {
    const now = this.now();
    if (
      this.lastScanAt !== null &&
      now - this.lastScanAt < (this.opts.rescanMs ?? DEFAULT_RESCAN_MS)
    ) {
      return;
    }
    this.lastScanAt = now;
    const docs = this.opts.doc ? [this.opts.doc] : await this.recentDocs();
    for (const doc of docs) {
      const log = marginLog(doc);
      if (this.tailers.has(log)) continue;
      await this.prime(log);
      this.tailers.set(
        log,
        new FileTailer({
          path: log,
          parser: this.parser,
          onMessage: this.opts.onMessage,
          onError: this.opts.onError,
          fs: this.fs,
          now: this.now,
        }),
      );
      this.opts.onFollow?.(log);
    }
  }

  /**
   * An existing log is followed from its end, so the parser must know the last event already in
   * it: otherwise a torn-line repair, which makes the tailer re-read from 0, would speak the
   * history. Events appended between this read and the tailer's first poll are skipped, never
   * repeated.
   */
  private async prime(log: string): Promise<void> {
    const stat = await this.fs.stat(log);
    if (!stat || stat.isDirectory || stat.size === 0) return;
    const bytes = await this.fs.readRange(log, Math.max(0, stat.size - PRIME_BYTES), stat.size);
    const seq = lastMarginSeq(new TextDecoder().decode(bytes));
    if (seq !== undefined) this.parser.prime(log, seq);
  }

  /** Margin's recent docs; [] when the list is missing or unreadable (e.g. caught mid-write). */
  private async recentDocs(): Promise<string[]> {
    const file = join(marginStateDir(this.opts.env ?? process.env), "recent-docs.json");
    const stat = await this.fs.stat(file);
    if (!stat || stat.isDirectory) return [];
    try {
      const list: unknown = JSON.parse(
        new TextDecoder().decode(await this.fs.readRange(file, 0, stat.size)),
      );
      return Array.isArray(list)
        ? list.filter((p): p is string => typeof p === "string" && isAbsolute(p))
        : [];
    } catch {
      return [];
    }
  }
}
