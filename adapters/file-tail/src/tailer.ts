// tailer.ts: follow a growing log file (or the newest matching file under a directory) and hand
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
  /** Called with the file being followed whenever that changes. */
  onFollow?: (file: string) => void;
  /** Called with errors from the file system; the tailer keeps going. */
  onError?: (error: unknown) => void;
  pollMs?: number;
  fs?: TailFs;
}

/** Directory levels searched below the root: sessions/YYYY/MM/DD (Codex) needs 4. */
const MAX_DEPTH = 4;
/** Bytes before the read offset that must still match, to catch a rewrite that grew past it. */
const FINGERPRINT_BYTES = 64;
/** At most this much is read per poll; the rest waits for the next one. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

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
 * - Directory mode follows the most recently modified matching file, switching when a newer one
 *   appears. The old file is drained first, then never followed again.
 * - Partial lines are buffered between reads. Truncation or rotation restarts from 0.
 * - Offsets only move forward within one version of a file, so no line is emitted twice.
 */
export class FileTailer {
  private readonly fs: TailFs;
  private readonly decoder = new TextDecoder();
  private cursor: Cursor | null = null;
  private initialized = false;
  /** Sizes of files that existed at start (directory mode). */
  private readonly sizesAtStart = new Map<string, number>();
  private readonly abandoned = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: FileTailerOptions) {
    this.fs = opts.fs ?? nodeTailFs;
  }

  /** The file being followed, or null before one exists. */
  get following(): string | null {
    return this.cursor?.file ?? null;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      if (!this.busy) void this.poll();
    }, this.opts.pollMs ?? 500);
  }

  stop(): void {
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
    if (!this.cursor) await this.follow(this.opts.path, 0);
    await this.drain();
  }

  private async pollDirectory(): Promise<void> {
    const files = await this.listMatching();
    if (!this.initialized) {
      this.initialized = true;
      for (const f of files) this.sizesAtStart.set(f.file, f.size);
      const newest = files[0];
      if (newest) await this.follow(newest.file, newest.size);
      return;
    }
    if (this.cursor) await this.drain();
    const currentMtime = this.cursor
      ? (files.find((f) => f.file === this.cursor?.file)?.mtimeMs ?? -1)
      : -1;
    const next = files.find(
      (f) =>
        f.file !== this.cursor?.file && !this.abandoned.has(f.file) && f.mtimeMs > currentMtime,
    );
    if (!next) return;
    if (this.cursor) this.abandoned.add(this.cursor.file);
    await this.follow(next.file, this.sizesAtStart.get(next.file) ?? 0);
    await this.drain();
  }

  /** Matching files up to MAX_DEPTH levels down, newest first. */
  private async listMatching(): Promise<{ file: string; size: number; mtimeMs: number }[]> {
    const found: { file: string; size: number; mtimeMs: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: { name: string; isDirectory: boolean }[];
      try {
        entries = await this.fs.listDir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          if (depth < MAX_DEPTH) await walk(path, depth + 1);
        } else if (!this.opts.pattern || this.opts.pattern.test(entry.name)) {
          const s = await this.fs.stat(path).catch(() => null);
          if (s && !s.isDirectory) found.push({ file: path, size: s.size, mtimeMs: s.mtimeMs });
        }
      }
    };
    await walk(this.opts.path, 1);
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private async follow(file: string, offset: number): Promise<void> {
    const s = await this.fs.stat(file);
    const cursor: Cursor = {
      file,
      offset,
      ino: s?.ino,
      partial: new Uint8Array(0),
      fingerprint: await this.readFingerprint(file, offset),
      skipToNewline: false,
    };
    // Starting mid-file after an unterminated line: its rest is not a whole message.
    cursor.skipToNewline = offset > 0 && cursor.fingerprint.at(-1) !== NEWLINE;
    this.cursor = cursor;
    this.opts.onFollow?.(file);
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

  /** Reads whatever was appended to the followed file and emits each complete line. */
  private async drain(): Promise<void> {
    const cursor = this.cursor;
    if (!cursor) return;
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
    let message: TailMessage | null;
    try {
      message = this.opts.parser(line, file);
    } catch {
      return;
    }
    if (message) this.opts.onMessage(message);
  }
}
