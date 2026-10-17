import type { NormalizedSpeakEvent } from "@mouthpiece/core";

/** Drops a repeated alert (same source, conversation, text) within windowMs (US-012). */
export class AlertDeduper {
  #seen = new Map<string, number>();

  constructor(
    public windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isDuplicate(event: NormalizedSpeakEvent): boolean {
    if (event.kind !== "alert") return false;
    const t = this.now();
    for (const [key, at] of this.#seen) if (t - at > this.windowMs) this.#seen.delete(key);
    const key = `${event.source}\u0000${event.conversationId}\u0000${event.text}`;
    if (this.#seen.has(key)) return true;
    this.#seen.set(key, t);
    return false;
  }
}
