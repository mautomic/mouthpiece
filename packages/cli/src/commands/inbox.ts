import { parseArgs } from "node:util";
import type { InboxEntry } from "@mouthpiece/core";
import type { CommandFn } from "../types.ts";
import { pick } from "./reply.ts";

const USAGE = "usage: mouthpiece inbox [--dismiss <id-prefix|label> | --clear]";

/**
 * `mouthpiece inbox` (US-025): the latest response of each conversation. `--dismiss` removes one
 * entry and `--clear` all of them; a session's next response brings it back.
 */
export const inboxCommand: CommandFn = async (args, io, deps) => {
  let values: { dismiss?: string; clear?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: { dismiss: { type: "string" }, clear: { type: "boolean" } },
    }));
  } catch (error) {
    io.err(`mouthpiece: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.clear) {
    const { dismissed } = await deps.client.dismissInbox({ all: true });
    io.out(`dismissed ${dismissed}\n`);
    return 0;
  }
  const { enabled, entries } = await deps.client.inbox();
  if (values.dismiss !== undefined) {
    const found = values.dismiss === "" ? [] : pick(entries, values.dismiss);
    if (Array.isArray(found)) {
      io.err(
        found.length === 0
          ? `mouthpiece: no inbox entry matches ${JSON.stringify(values.dismiss)}\n`
          : `mouthpiece: ${JSON.stringify(values.dismiss)} matches several; use an id:\n${found
              .map((e) => `  ${e.id.slice(0, 8)}  ${e.label ?? e.source}\n`)
              .join("")}`,
      );
      return 2;
    }
    await deps.client.dismissInbox({ id: found.id });
    io.out(`dismissed ${found.label ?? found.source}\n`);
    return 0;
  }
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
