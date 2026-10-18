// margin.ts: speak an agent's replies from a Margin review log, `.margin/<doc>.jsonl` beside the
// reviewed doc (US-014). The log format is Margin's own and may change; anything unexpected is
// null, never an error.
import { basename, dirname, extname, join } from "node:path";
import { isRecord } from "@mouthpiece/core";
import type { LineParser } from "./tailer.ts";

const MAX_LABEL_CHARS = 100;
const MAX_CONVERSATION_ID_CHARS = 256;

/** The doc `/d/PRD.md` → its log `/d/.margin/PRD.md.jsonl` (Margin's naming). */
export function marginLog(doc: string): string {
  return join(dirname(doc), ".margin", `${basename(doc)}.jsonl`);
}

/** The log `/d/.margin/PRD.md.jsonl` → its doc `/d/PRD.md`. */
export function marginDoc(logFile: string): string {
  return join(dirname(dirname(logFile)), basename(logFile, ".jsonl"));
}

/** A Margin log parser that can be told where a log stood when following began. */
export type MarginParser = LineParser & {
  /** Marks every event up to `seq` in `file` as seen (the log is followed from its end). */
  prime(file: string, seq: number): void;
};

/**
 * A parser for Margin logs: an agent's reply, or an agent suggestion's note. Each event's `seq`
 * only grows within a log, so an event at or below the last seen (or primed) in that file is
 * skipped. When Margin cuts a torn line after a crash, the tailer re-reads from 0 and nothing is
 * repeated.
 */
export function createMarginParser(): MarginParser {
  const lastSeq = new Map<string, number>();
  const parse: LineParser = (line, file) => {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(record) || typeof record.seq !== "number") return null;
    const last = lastSeq.get(file);
    if (last !== undefined && record.seq <= last) return null;
    lastSeq.set(file, record.seq);
    if (record.by !== "agent" || typeof record.id !== "string") return null;
    const text = spokenText(record);
    if (text === null) return null;
    const doc = marginDoc(file);
    const name = basename(doc);
    return {
      text,
      conversationId: `${doc}#${record.id}`.slice(-MAX_CONVERSATION_ID_CHARS),
      label: (name.slice(0, name.length - extname(name).length) || name).slice(0, MAX_LABEL_CHARS),
    };
  };
  return Object.assign(parse, {
    prime(file: string, seq: number) {
      lastSeq.set(file, Math.max(seq, lastSeq.get(file) ?? seq));
    },
  });
}

/** The `seq` of the last complete event in a log's tail bytes; undefined when there is none. */
export function lastMarginSeq(tail: string): number | undefined {
  const lines = tail.split("\n").slice(0, -1); // the last piece is torn or empty
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record: unknown = JSON.parse(lines[i] ?? "");
      if (isRecord(record) && typeof record.seq === "number") return record.seq;
    } catch {
      // The window's first piece can start mid-line; keep looking back.
    }
  }
  return undefined;
}

function spokenText(record: Record<string, unknown>): string | null {
  if (record.type === "reply" && typeof record.text === "string" && record.text.trim()) {
    return record.text;
  }
  if (record.type === "suggest" && typeof record.note === "string" && record.note.trim()) {
    return `Suggested edit: ${record.note}`;
  }
  return null;
}
