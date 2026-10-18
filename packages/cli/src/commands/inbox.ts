import type { InboxEntry } from "@mouthpiece/core";
import type { CommandFn } from "../types.ts";

/** `mouthpiece inbox` (US-025): the latest response of each conversation. */
export const inboxCommand: CommandFn = async (_args, io, deps) => {
  const { enabled, entries } = await deps.client.inbox();
  const now = (deps.now ?? Date.now)();
  for (const e of entries) io.out(`${inboxLine(e, now)}\n`);
  io.out(`replies: ${enabled ? "on" : "off"}\n`);
  return 0;
};

export function inboxLine(e: InboxEntry, now: number): string {
  const text = (e.summary ?? e.text).replace(/\s+/g, " ").trim().slice(0, 60);
  return `${e.id.slice(0, 8)}  ${e.label ?? e.source}  ${e.state}  ${age(now - e.at)}  ${text}`;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
