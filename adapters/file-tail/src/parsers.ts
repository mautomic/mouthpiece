// parsers.ts: turn one session-log line into a message to speak (US-014). The Codex and Gemini
// formats are undocumented and may change; anything unexpected is null, never an error.
import { isRecord } from "@mouthpiece/core";
import { createMarginParser } from "./margin.ts";
import type { LineParser } from "./tailer.ts";

export const TAIL_FORMATS = ["codex", "gemini", "lines", "margin"] as const;
export type TailFormat = (typeof TAIL_FORMATS)[number];

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** `rollout-<ts>-<uuid>.jsonl` → the uuid. */
const ROLLOUT_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** `session-<ts>-<id>.jsonl` → the id (the last dash-separated part). */
const GEMINI_SESSION_ID = /^session-.*-([^-/]+)\.jsonl$/;

/** Codex rollout lines: `{timestamp, type, payload}`; the final answer is `event_msg`/`task_complete`. */
const codex: LineParser = (line, file) => {
  const record = parseRecord(line);
  if (record?.type !== "event_msg" || !isRecord(record.payload)) return null;
  const { payload } = record;
  const text = payload.last_agent_message;
  if (payload.type !== "task_complete" || typeof text !== "string" || !text.trim()) return null;
  return { text, conversationId: ROLLOUT_UUID.exec(file)?.[1] };
};

/** Gemini chat lines: `{id, type, content}` messages plus `{$patch|$set|$rewindTo}` mutations (ignored). */
const gemini: LineParser = (line, file) => {
  if (line.startsWith('{"$')) return null;
  const record = parseRecord(line);
  if (record?.type !== "gemini") return null;
  const text = contentText(record.content);
  if (!text.trim()) return null;
  const name = file.slice(file.lastIndexOf("/") + 1);
  return { text, conversationId: GEMINI_SESSION_ID.exec(name)?.[1] };
};

/** Gemini `content` is a string or a list of `{text}` parts (joined with newlines). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { text: string } => isRecord(p) && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** Any text log: each non-empty line is a message. */
const lines: LineParser = (line) => {
  const text = line.trim();
  return text ? { text } : null;
};

export const PARSERS: Record<TailFormat, LineParser> = {
  codex,
  gemini,
  lines,
  margin: createMarginParser(),
};
