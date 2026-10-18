import type { PlayerProcess } from "./stream-player.ts";

/** In-memory mouthpiece-player for StreamPlayer tests: records commands and emits events on demand. */
export class FakePlayerProcess implements PlayerProcess {
  /** Every command received, parsed. */
  readonly commands: Record<string, unknown>[] = [];
  readonly exited: Promise<number>;
  killed = false;
  #exit: (code: number) => void = () => {};
  #queue: string[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  constructor(opts: { ready?: boolean } = {}) {
    this.exited = new Promise((resolve) => {
      this.#exit = resolve;
    });
    if (opts.ready ?? true) this.emit({ event: "ready" });
  }

  send(line: string): void {
    this.commands.push(JSON.parse(line));
  }

  /** The commands as "op id" strings, e.g. ["clip 1", "audio 1", "end 1", "flush"]. */
  get ops(): string[] {
    return this.commands.map((c) => (c.id === undefined ? String(c.op) : `${c.op} ${c.id}`));
  }

  emit(event: Record<string, unknown>): void {
    this.#queue.push(JSON.stringify(event));
    this.#wake?.();
  }

  /** The process dies with `code`. */
  exit(code: number): void {
    this.#closed = true;
    this.#wake?.();
    this.#exit(code);
  }

  kill(): void {
    this.killed = true;
    this.exit(137);
  }

  get lines(): AsyncIterable<string> {
    const next = async (): Promise<string | undefined> => {
      while (this.#queue.length === 0 && !this.#closed) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
      return this.#queue.shift();
    };
    return {
      async *[Symbol.asyncIterator]() {
        for (let line = await next(); line !== undefined; line = await next()) yield line;
      },
    };
  }
}
