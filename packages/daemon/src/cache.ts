import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  type AudioClip,
  type AudioFormat,
  type SynthesizeOptions,
  singleChunk,
  type TtsProvider,
} from "@mouthpiece/core";

const FORMATS: AudioFormat[] = ["mp3", "aiff", "wav"];

export interface CacheOptions {
  dir: string;
  maxBytes: number;
}

/** LRU audio cache for paid providers. Only fully consumed, error-free streams are written. */
export class CachingProvider implements TtsProvider {
  constructor(
    private readonly inner: TtsProvider,
    private readonly opts: CacheOptions,
  ) {}

  get name() {
    return this.inner.name;
  }
  get maxCharsPerRequest() {
    return this.inner.maxCharsPerRequest;
  }
  get pricePerMillionChars() {
    return this.inner.pricePerMillionChars;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    if (this.opts.maxBytes === 0) return this.inner.synthesize(text, options);
    const key = createHash("sha256")
      .update(`${this.inner.name}\u0000${options.voice ?? ""}\u0000${text}`)
      .digest("hex");
    for (const format of FORMATS) {
      const path = join(this.opts.dir, `${key}.${format}`);
      const file = Bun.file(path);
      if (await file.exists()) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const now = new Date();
          await utimes(path, now, now);
          return { format, cached: true, chunks: singleChunk(bytes) };
        } catch {
          // Evicted between exists() and read: fall through to the provider.
        }
      }
    }
    const clip = await this.inner.synthesize(text, options);
    return { format: clip.format, chunks: this.#tee(clip, key) };
  }

  async *#tee(clip: AudioClip, key: string): AsyncIterable<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const part of clip.chunks) {
      parts.push(part);
      yield part;
    }
    // Reached only when the consumer read everything and the stream did not throw.
    // A cache write failure must never fail playback that already succeeded.
    try {
      await mkdir(this.opts.dir, { recursive: true });
      const final = join(this.opts.dir, `${key}.${clip.format}`);
      const tmp = `${final}.tmp-${process.pid}-${randomUUID()}`;
      await Bun.write(tmp, Buffer.concat(parts));
      await rename(tmp, final);
      await this.#evict();
    } catch {
      // Best effort.
    }
  }

  async #evict(): Promise<void> {
    const entries = (
      await Promise.all(
        (
          await readdir(this.opts.dir)
        ).map(async (name) => {
          const path = join(this.opts.dir, name);
          try {
            const s = await stat(path);
            return { path, size: s.size, mtime: s.mtimeMs };
          } catch {
            return undefined; // removed concurrently
          }
        }),
      )
    ).filter((e) => e !== undefined);
    entries.sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (total <= this.opts.maxBytes) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
  }
}
