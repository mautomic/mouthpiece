import type { Config, InboxEntry, InboxState, NormalizedSpeakEvent } from "@mouthpiece/core";

export type InboxChange = { type: "entry"; entry: InboxEntry } | { type: "remove"; id: string };

/** An entry as the daemon holds it: the reply text stays here and is never returned (PRD §13). */
export interface StoredEntry extends InboxEntry {
  replyText?: string;
}

export interface InboxOptions {
  history: Config["history"];
  now?: () => number;
  newId?: () => string;
}

const REPLACED_CAP = 1000;

/** The latest response per conversation, for replying to it (US-025). In memory only. */
export class Inbox {
  #entries = new Map<string, StoredEntry>();
  /** Ids a newer response replaced, oldest first, capped. */
  #replaced = new Set<string>();
  #listeners = new Set<(change: InboxChange) => void>();
  #history: Config["history"];
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(opts: InboxOptions) {
    this.#history = opts.history;
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
  }

  configure(history: Config["history"]): void {
    this.#history = history;
    this.#prune();
  }

  /** Records a response (returns its entry id) or attaches an alert; anything else is ignored. */
  record(event: NormalizedSpeakEvent): string | undefined {
    const key = keyOf(event.source, event.conversationId);
    const existing = this.#entries.get(key);
    if (event.kind === "alert") {
      if (!existing) return undefined;
      existing.alert = { text: event.text, at: this.#now() };
      if (event.reply) existing.route = event.reply;
      this.#emit(existing);
      return undefined;
    }
    if (event.kind !== "response") return undefined;
    const route = event.reply ?? existing?.route;
    const entry: StoredEntry = {
      id: this.#newId(),
      source: event.source,
      conversationId: event.conversationId,
      ...(event.label !== undefined && { label: event.label }),
      text: event.text,
      at: this.#now(),
      ...(existing?.alert && { alert: existing.alert }),
      ...(route && { route }),
      state: "waiting",
    };
    if (existing) {
      this.#replaced.add(existing.id);
      if (this.#replaced.size > REPLACED_CAP) {
        this.#replaced.delete(this.#replaced.values().next().value as string);
      }
    }
    // A Map keeps insertion order; re-inserting moves the conversation to the newest end.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#emit(entry);
    this.#prune();
    return entry.id;
  }

  summarized(id: string, summary: string): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.summary = summary;
    this.#emit(entry);
  }

  interrupted(source: string, conversationId?: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.source !== source) continue;
      if (conversationId !== undefined && entry.conversationId !== conversationId) continue;
      if (entry.state === "busy") continue;
      entry.state = "busy";
      this.#emit(entry);
    }
  }

  get(id: string): StoredEntry | undefined {
    this.#prune();
    for (const entry of this.#entries.values()) if (entry.id === id) return entry;
    return undefined;
  }

  /** True when `id` was an entry that a newer response replaced. */
  replaced(id: string): boolean {
    return this.#replaced.has(id);
  }

  /** Applies only while `id` is the conversation's current entry. */
  setState(id: string, state: InboxState, reply?: { text: string; at: number }): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.state = state;
    if (reply) {
      entry.replyText = reply.text;
      entry.reply = { at: reply.at };
    }
    this.#emit(entry);
  }

  /** Newest first, without reply text. */
  list(): InboxEntry[] {
    this.#prune();
    return [...this.#entries.values()].reverse().map(publicEntry);
  }

  subscribe(listener: (change: InboxChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(entry: StoredEntry): void {
    const change: InboxChange = { type: "entry", entry: publicEntry(entry) };
    for (const listener of this.#listeners) listener(change);
  }

  /** Oldest first (Map order): drop past maxAgeMs, then down to maxItems. */
  #prune(): void {
    const cutoff = this.#now() - this.#history.maxAgeMs;
    let excess = this.#entries.size - this.#history.maxItems;
    const removed: string[] = [];
    for (const [key, entry] of this.#entries) {
      if (excess <= 0 && entry.at >= cutoff) continue;
      this.#entries.delete(key);
      removed.push(entry.id);
      excess--;
    }
    for (const id of removed) for (const l of this.#listeners) l({ type: "remove", id });
  }
}

function keyOf(source: string, conversationId: string): string {
  return `${source}\u0000${conversationId}`;
}

function publicEntry(entry: StoredEntry): InboxEntry {
  const { replyText: _, ...rest } = entry;
  return structuredClone(rest);
}
