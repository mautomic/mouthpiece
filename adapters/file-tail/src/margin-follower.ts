// margin-follower.ts: follow the logs of the docs a Margin tab shows right now (US-014). The list
// comes from the running Margin server (`GET /api/status`, with the token from its daemon.json).
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Env, isRecord } from "@mouthpiece/core";
import { createMarginParser, lastMarginSeq, marginLog } from "./margin.ts";
import { FileTailer, nodeTailFs, type TailFs, type TailMessage } from "./tailer.ts";

const DEFAULT_RESCAN_MS = 2000;
/** Margin's server answers its status from memory; a slower answer is "can't tell". */
const STATUS_TIMEOUT_MS = 1000;
/** How much of a log's end is read to find where it stands when following begins. */
const PRIME_BYTES = 64 * 1024;

export interface MarginFollowerOptions {
  /** Follow just this doc; by default, every doc a Margin tab shows right now. */
  doc?: string;
  /** Where Margin's state dir is found (MARGIN_STATE_DIR, XDG_RUNTIME_DIR, HOME). */
  env?: Env;
  onMessage: (m: TailMessage) => void;
  onFollow?: (log: string) => void;
  /** Called when a doc's last tab closes (or Margin stops) and its log stops being followed. */
  onUnfollow?: (log: string) => void;
  onError?: (error: unknown) => void;
  pollMs?: number;
  /** How often Margin's server is asked which docs are open (default 2 s). */
  rescanMs?: number;
  now?: () => number;
  fs?: TailFs;
  /** Test seam for the request to Margin's server. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Margin's state dir, in Margin's own order. */
export function marginStateDir(env: Env): string {
  if (env.MARGIN_STATE_DIR) return env.MARGIN_STATE_DIR;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "margin");
  return join(env.HOME || homedir(), ".cache", "margin");
}

/**
 * Follows the log of each doc a Margin tab shows, with its own FileTailer: an existing log from
 * its end, a new one from its start. A doc stops being followed when its last tab closes or Margin
 * stops, and is followed again (from its end) when a tab shows it again.
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
    const docs = this.opts.doc ? [this.opts.doc] : await this.activeDocs();
    if (docs === undefined) return; // Margin couldn't say: keep what is followed
    const logs = new Set(docs.map(marginLog));
    for (const [log, tailer] of this.tailers) {
      if (logs.has(log)) continue;
      tailer.stop();
      this.tailers.delete(log);
      this.opts.onUnfollow?.(log);
    }
    for (const log of logs) {
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

  /**
   * The docs a Margin tab shows right now: [] when Margin isn't running (no daemon.json, or
   * nothing listening on its port), undefined when its server can't say (an error, a slow or
   * garbled answer), so a passing hiccup never drops a doc.
   */
  private async activeDocs(): Promise<string[] | undefined> {
    const info = await this.readJson(
      join(marginStateDir(this.opts.env ?? process.env), "daemon.json"),
    );
    if (!isRecord(info) || typeof info.port !== "number" || typeof info.token !== "string")
      return [];
    let response: Response;
    try {
      response = await (this.opts.fetch ?? fetch)(`http://127.0.0.1:${info.port}/api/status`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
    } catch (error) {
      return isRecord(error) && error.code === "ConnectionRefused" ? [] : undefined;
    }
    if (!response.ok) return undefined;
    const status: unknown = await response.json().catch(() => undefined);
    if (!isRecord(status) || !Array.isArray(status.docs)) return undefined;
    return status.docs
      .filter(
        (d): d is { path: string } =>
          isRecord(d) &&
          typeof d.path === "string" &&
          isAbsolute(d.path) &&
          typeof d.clients === "number" &&
          d.clients > 0,
      )
      .map((d) => d.path);
  }

  /** A small JSON file's value; undefined when it is missing or unreadable. */
  private async readJson(file: string): Promise<unknown> {
    const stat = await this.fs.stat(file);
    if (!stat || stat.isDirectory) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(await this.fs.readRange(file, 0, stat.size)));
    } catch {
      return undefined;
    }
  }
}
