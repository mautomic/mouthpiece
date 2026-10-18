// tailer.ts: follow a growing log file (or every active matching file under a directory) and hand
// each complete new line to a parser (US-014, the fallback for tools without hooks).
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface TailMessage {
  text: string;
  conversationId?: string;
  label?: string;
}

export type LineParser = (line: string, file: string) => TailMessage | null;

export interface TailStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  ino?: number;
}

export interface TailFs {
  /** null when the path does not exist. */
  stat(path: string): Promise<TailStat | null>;
  /** Bytes [start, end) of the file. */
  readRange(path: string, start: number, end: number): Promise<Uint8Array>;
  listDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
}

export const nodeTailFs: TailFs = {
  async stat(path) {
    try {
      const s = await stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), ino: s.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async readRange(path, start, end) {
    const handle = await open(path, "r");
    try {
      const buffer = new Uint8Array(Math.max(0, end - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  async listDir(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  },
};

export interface FileTailerOptions {
  path: string;
  /** Directory mode only: which file names to follow (default: any). */
  pattern?: RegExp;
  parser: LineParser;
  onMessage: (m: TailMessage) => void;
  /** Called with each file when it starts being followed. */
  onFollow?: (file: string) => void;
  /** Called with errors from the file system; the tailer keeps going. */
  onError?: (error: unknown) => void;
  pollMs?: number;
  /** Directory mode: a file that has not grown for this long stops being followed (default 30 min). */
  idleMs?: number;
  /**
   * Directory mode: how often to walk the tree for new or changed files (default 5 s). Followed
   * files are still read on every poll.
   */
  rescanMs?: number;
  now?: () => number;
  fs?: TailFs;
}

/** Directory levels searched below the root: sessions/YYYY/MM/DD (Codex) needs 4. */
const MAX_DEPTH = 4;
/** Bytes before the read offset that must still match, to catch a rewrite that grew past it. */
const FINGERPRINT_BYTES = 64;
/** At most this much is read per poll; the rest waits for the next one. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const DEFAULT_IDLE_MS = 30 * 60_000;
const DEFAULT_RESCAN_MS = 5000;
/**
 * Every this many rescans (and at start) the walk is full, old date directories included, so a
 * resumed old session is still found (within about a minute at the default rescanMs).
 */
export const FULL_SCAN_EVERY = 12;
const DAY_MS = 24 * 60 * 60_000;

/**
 * The date so far along a `YYYY/MM/DD` directory path (Codex's sessions layout), or null when
 * `name` doesn't continue one. Directories that aren't dates (Gemini's `tmp/<project>/chats`) are
 * never pruned.
 */
function datePrefix(prefix: number[], name: string): number[] | null {
  if (prefix.length === 0 ? !/^\d{4}$/.test(name) : prefix.length > 2 || !/^\d{2}$/.test(name)) {
    return null;
  }
  return [...prefix, Number(name)];
}

/** True when a date prefix (year, then month, then day) is wholly before the cutoff date. */
function isBefore(prefix: number[], cutoff: number[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    const a = prefix[i] ?? 0;
    const b = cutoff[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

interface Cursor {
  file: string;
  offset: number;
  ino?: number;
  /** An incomplete last line, carried to the next read. */
  partial: Uint8Array;
  /** The bytes just before `offset`, as last read. */
  fingerprint: Uint8Array;
  /** Skip up to the next newline (we started in the middle of a line). */
  skipToNewline: boolean;
  /** When it started being followed or last grew. */
  activeAt: number;
}

/** A matching file that is not being followed: how it looked, and where to resume if it changes. */
interface Baseline {
  size: number;
  mtimeMs: number;
  ino?: number;
  resumeAt: number;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Semantics:
 * - It starts at the end of the file, so history is not spoken. A file (or, in directory mode,
 *   a matching file) that first appears after start is read from its beginning.
 * - Directory mode follows every matching file that changes, each with its own cursor, so
 *   concurrent or resumed sessions are all heard. At start it follows the newest file; any other
 *   file is followed once it changes, from its size when first seen. A file that has not grown
 *   for idleMs is retired and followed again, from where it stopped, if it grows later.
 * - Partial lines are buffered between reads. Truncation or rotation restarts from 0.
 * - Offsets only move forward within one version of a file, so no line is emitted twice.
 */
export class FileTailer {
  private readonly fs: TailFs;
  private readonly decoder = new TextDecoder();
  private readonly now: () => number;
  /** Followed files, in the order they started being followed. */
  private readonly cursors = new Map<string, Cursor>();
  /** Directory mode: matching files seen but not followed. */
  private readonly baselines = new Map<string, Baseline>();
  private mostRecent: string | null = null;
  private initialized = false;
  private lastScanAt = 0;
  private scans = 0;
  private chain: Promise<void> = Promise.resolve();
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Set by stop(): a poll already queued or running then emits nothing. */
  private stopped = false;

  constructor(private readonly opts: FileTailerOptions) {
    this.fs = opts.fs ?? nodeTailFs;
    this.now = opts.now ?? Date.now;
  }

  /** The most recently active followed file, or null when nothing is followed. */
  get following(): string | null {
    return this.mostRecent !== null && this.cursors.has(this.mostRecent) ? this.mostRecent : null;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => {
      if (!this.busy) void this.poll();
    }, this.opts.pollMs ?? 500);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll; calls are serialized, so each one sees everything written before it was made. */
  poll(): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.busy = true;
      try {
        await this.pollOnce();
      } catch (error) {
        this.opts.onError?.(error);
      } finally {
        this.busy = false;
      }
    });
    return this.chain;
  }

  private async pollOnce(): Promise<void> {
    const root = await this.fs.stat(this.opts.path);
    if (root?.isDirectory) return this.pollDirectory();
    if (!this.initialized) {
      this.initialized = true;
      // A file that already exists starts at its end; one that appears later starts at 0.
      if (root) await this.follow(this.opts.path, root.size);
      return;
    }
    if (!root) return;
    let cursor = this.cursors.get(this.opts.path);
    if (!cursor) cursor = await this.follow(this.opts.path, 0);
    await this.drain(cursor);
  }

  private async pollDirectory(): Promise<void> {
    if (!this.initialized) {
      this.initialized = true;
      const files = await this.listMatching(true);
      for (const f of files) this.baselines.set(f.file, { ...f, resumeAt: f.size });
      const newest = files[0];
      if (newest) await this.follow(newest.file, newest.size);
      return;
    }
    for (const cursor of this.cursors.values()) await this.drain(cursor);
    await this.retireIdle();
    if (this.now() - this.lastScanAt >= (this.opts.rescanMs ?? DEFAULT_RESCAN_MS)) {
      await this.discover();
    }
  }

  /** Starts following new files (from 0) and changed known ones (from their baseline), oldest first. */
  private async discover(): Promise<void> {
    const full = ++this.scans % FULL_SCAN_EVERY === 0;
    const files = (await this.listMatching(full)).reverse();
    for (const f of files) {
      if (this.cursors.has(f.file)) continue;
      const base = this.baselines.get(f.file);
      if (base && f.size === base.size && f.mtimeMs === base.mtimeMs && f.ino === base.ino)
        continue;
      const sameFile = base !== undefined && f.ino === base.ino && f.size >= base.size;
      this.baselines.delete(f.file);
      await this.drain(await this.follow(f.file, sameFile ? base.resumeAt : 0));
    }
  }

  /** Stops following files that have not grown for idleMs, remembering where to resume. */
  private async retireIdle(): Promise<void> {
    const now = this.now();
    for (const cursor of [...this.cursors.values()]) {
      if (now - cursor.activeAt < (this.opts.idleMs ?? DEFAULT_IDLE_MS)) continue;
      const s = await this.fs.stat(cursor.file);
      if (!s) {
        this.cursors.delete(cursor.file);
        continue;
      }
      // It changed since drain read it: keep following, or the bytes since then would be lost.
      const replaced = s.ino !== undefined && cursor.ino !== undefined && s.ino !== cursor.ino;
      if (s.size !== cursor.offset || replaced) continue;
      this.cursors.delete(cursor.file);
      // Resume before a buffered partial line, so it is read whole next time.
      this.baselines.set(cursor.file, {
        size: cursor.offset,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
        resumeAt: cursor.offset - cursor.partial.length,
      });
    }
  }

  /**
   * Matching files up to MAX_DEPTH levels down, newest first. Unless `full`, date directories older
   * than yesterday (as of this scan) are skipped, so the walk stays small as history grows.
   */
  private async listMatching(
    full: boolean,
  ): Promise<{ file: string; size: number; mtimeMs: number; ino?: number }[]> {
    const found: { file: string; size: number; mtimeMs: number; ino?: number }[] = [];
    this.lastScanAt = this.now();
    const dayBefore = new Date(this.lastScanAt - DAY_MS);
    const cutoff = [dayBefore.getFullYear(), dayBefore.getMonth() + 1, dayBefore.getDate()];
    const walk = async (dir: string, depth: number, date: number[]): Promise<void> => {
      let entries: { name: string; isDirectory: boolean }[];
      try {
        entries = await this.fs.listDir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          const next = datePrefix(date, entry.name);
          if (depth < MAX_DEPTH && (full || !next || !isBefore(next, cutoff))) {
            await walk(path, depth + 1, next ?? []);
          }
        } else if (!this.opts.pattern || this.opts.pattern.test(entry.name)) {
          const s = await this.fs.stat(path).catch(() => null);
          if (s && !s.isDirectory) {
            found.push({ file: path, size: s.size, mtimeMs: s.mtimeMs, ino: s.ino });
          }
        }
      }
    };
    await walk(this.opts.path, 1, []);
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private async follow(file: string, offset: number): Promise<Cursor> {
    const s = await this.fs.stat(file);
    const cursor: Cursor = {
      file,
      offset,
      ino: s?.ino,
      partial: new Uint8Array(0),
      fingerprint: await this.readFingerprint(file, offset),
      skipToNewline: false,
      activeAt: this.now(),
    };
    // Starting mid-file after an unterminated line: its rest is not a whole message.
    cursor.skipToNewline = offset > 0 && cursor.fingerprint.at(-1) !== NEWLINE;
    this.cursors.set(file, cursor);
    this.mostRecent = file;
    this.opts.onFollow?.(file);
    return cursor;
  }

  private readFingerprint(file: string, offset: number): Promise<Uint8Array> {
    if (offset === 0) return Promise.resolve(new Uint8Array(0));
    return this.fs.readRange(file, Math.max(0, offset - FINGERPRINT_BYTES), offset);
  }

  private restart(cursor: Cursor, ino: number | undefined): void {
    cursor.offset = 0;
    cursor.ino = ino;
    cursor.partial = new Uint8Array(0);
    cursor.fingerprint = new Uint8Array(0);
    cursor.skipToNewline = false;
  }

  /** Reads whatever was appended to a followed file and emits each complete line. */
  private async drain(cursor: Cursor): Promise<void> {
    const s = await this.fs.stat(cursor.file);
    if (!s) return;
    if (
      s.size < cursor.offset ||
      (s.ino !== undefined && cursor.ino !== undefined && s.ino !== cursor.ino)
    ) {
      this.restart(cursor, s.ino);
    } else if (cursor.offset > 0) {
      const now = await this.readFingerprint(cursor.file, cursor.offset);
      if (!sameBytes(now, cursor.fingerprint)) this.restart(cursor, s.ino);
    }
    if (s.size === cursor.offset) return;
    const end = Math.min(s.size, cursor.offset + MAX_READ_BYTES);
    const data = await this.fs.readRange(cursor.file, cursor.offset, end);
    if (data.length === 0) return;
    cursor.offset += data.length;
    cursor.activeAt = this.now();
    this.mostRecent = cursor.file;
    const tail = concat(cursor.fingerprint, data);
    cursor.fingerprint = tail.slice(Math.max(0, tail.length - FINGERPRINT_BYTES));

    const bytes = concat(cursor.partial, data);
    let start = 0;
    if (cursor.skipToNewline) {
      const nl = bytes.indexOf(NEWLINE);
      if (nl === -1) {
        cursor.partial = new Uint8Array(0);
        return;
      }
      cursor.skipToNewline = false;
      start = nl + 1;
    }
    for (let nl = bytes.indexOf(NEWLINE, start); nl !== -1; nl = bytes.indexOf(NEWLINE, start)) {
      this.emit(this.decoder.decode(bytes.subarray(start, nl)).replace(/\r$/, ""), cursor.file);
      start = nl + 1;
    }
    cursor.partial = bytes.slice(start);
  }

  private emit(line: string, file: string): void {
    if (this.stopped) return;
    let message: TailMessage | null;
    try {
      message = this.opts.parser(line, file);
    } catch {
      return;
    }
    if (message) this.opts.onMessage(message);
  }
}
