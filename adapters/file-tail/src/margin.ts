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

/**
 * A parser for Margin logs: an agent's reply, or an agent suggestion's note. Each event's `seq`
 * only grows within a log, so an event at or below the last seen in that file is skipped. When
 * Margin cuts a torn line after a crash, the tailer re-reads from 0 and nothing is repeated.
 */
export function createMarginParser(): LineParser {
  const lastSeq = new Map<string, number>();
  return (line, file) => {
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
