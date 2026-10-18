import type { Config } from "@mouthpiece/core";
import type { SpokenRecord } from "./types.ts";

/** Recently spoken items for replay (FR-7: last 100 or 24 h). */
export class History {
  #items: SpokenRecord[] = [];

  constructor(
    private opts: Config["history"],
    private readonly now: () => number = Date.now,
  ) {}

  configure(opts: Config["history"]): void {
    this.opts = opts;
    this.#prune();
  }

  add(record: SpokenRecord): void {
    this.#items.push(record);
    this.#prune();
  }

  last(): SpokenRecord | undefined {
    this.#prune();
    return this.#items.at(-1);
  }

  get size(): number {
    this.#prune();
    return this.#items.length;
  }

  #prune(): void {
    const cutoff = this.now() - this.opts.maxAgeMs;
    this.#items = this.#items.filter((r) => r.at >= cutoff).slice(-this.opts.maxItems);
  }
}
