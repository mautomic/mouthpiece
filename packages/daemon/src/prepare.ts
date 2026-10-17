import {
  cleanForSpeech,
  type Logger,
  type NormalizedSpeakEvent,
  type Summarizer,
} from "@mouthpiece/core";
import type { Prepared, ResolveMode } from "./types.ts";

// skipReason (request path), the preparer, and the speaker all need the cleaned text; clean each event once.
const cleaned = new WeakMap<NormalizedSpeakEvent, string>();

/** Cleaned text for an event (memoized; plain events pass through). */
export function speakable(event: NormalizedSpeakEvent): string {
  if (event.format === "plain") return event.text.trim();
  let text = cleaned.get(event);
  if (text === undefined) {
    text = cleanForSpeech(event.text);
    cleaned.set(event, text);
  }
  return text;
}

export interface PreparerSettings {
  summarizer: Summarizer | undefined;
  fallback: Summarizer;
  thresholdChars: number;
}

export interface PreparerDeps {
  resolveMode: ResolveMode;
  /** Read on every prepare so config reloads apply. */
  settings: () => PreparerSettings;
  log: Logger;
  now?: () => number;
}

export interface Preparer {
  prepare(event: NormalizedSpeakEvent): Promise<Prepared>;
}

/** Decides what to say for an event. Started at enqueue time so summarizing overlaps current playback. */
export function createPreparer(deps: PreparerDeps): Preparer {
  const now = deps.now ?? Date.now;
  const memo = new WeakMap<NormalizedSpeakEvent, Promise<Prepared>>();

  async function run(event: NormalizedSpeakEvent): Promise<Prepared> {
    const mode = deps.resolveMode(event);
    const full = speakable(event);
    const { summarizer, fallback, thresholdChars } = deps.settings();
    if (mode !== "summary" || event.kind !== "response" || full.length <= thresholdChars) {
      return { mode, full, summary: undefined, spoken: full };
    }
    let summary: string | undefined;
    if (summarizer) {
      const started = now();
      try {
        summary = await summarizer.summarize(full, { source: event.source });
        deps.log({
          msg: "summarized",
          source: event.source,
          ms: now() - started,
          chars: summary.length,
        });
      } catch (error) {
        deps.log({
          level: "warn",
          msg: "summary_failed",
          source: event.source,
          error: String(error),
        });
      }
    }
    summary ??= await fallback.summarize(full, { source: event.source }).catch(() => full);
    return { mode, full, summary, spoken: summary };
  }

  return {
    prepare(event) {
      let pending = memo.get(event);
      if (!pending) {
        pending = run(event);
        memo.set(event, pending);
      }
      return pending;
    },
  };
}
