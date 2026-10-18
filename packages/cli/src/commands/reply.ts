import { parseArgs } from "node:util";
import { MouthpieceError } from "@mouthpiece/client";
import type { InboxEntry } from "@mouthpiece/core";
import type { CliDeps, CliIO, CommandFn } from "../types.ts";

const USAGE =
  "usage: mouthpiece reply <id-prefix|label> [text…]   (text from stdin when omitted)\n" +
  "       mouthpiece reply --submit <id-prefix|label>";

/**
 * `mouthpiece reply` (US-025). Exits 0 when submitted, 3 when typed but not submitted, 1 when
 * refused, 2 on a usage error.
 */
export const replyCommand: CommandFn = async (args, io, deps) => {
  let values: { submit?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { submit: { type: "boolean" } },
    }));
  } catch (error) {
    io.err(`mouthpiece: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const [target, ...words] = positionals;
  if (target === undefined) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const { entries } = await deps.client.inbox();
  const found = pick(entries, target);
  if (!Array.isArray(found)) return await deliver(found, values.submit === true, words, io, deps);
  io.err(
    found.length === 0
      ? `mouthpiece: no inbox entry matches ${JSON.stringify(target)}\n`
      : `mouthpiece: ${JSON.stringify(target)} matches several; use an id:\n${found
          .map((e) => `  ${e.id.slice(0, 8)}  ${e.label ?? e.source}\n`)
          .join("")}`,
  );
  return 2;
};

/** One entry by id prefix, else by label; otherwise every candidate (none or several). */
function pick(entries: InboxEntry[], target: string): InboxEntry | InboxEntry[] {
  const byId = entries.filter((e) => e.id.startsWith(target));
  if (byId.length === 1) return byId[0] as InboxEntry;
  const byLabel = entries.filter((e) => (e.label ?? e.source) === target);
  if (byLabel.length === 1) return byLabel[0] as InboxEntry;
  return byLabel.length > 1 ? byLabel : byId;
}

async function deliver(
  entry: InboxEntry,
  submit: boolean,
  words: string[],
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  const name = entry.label ?? entry.source;
  let text = "";
  if (!submit) {
    text = (words.length > 0 ? words.join(" ") : io.stdinIsTTY ? "" : await io.readStdin()).trim();
    if (!text) {
      io.err(`mouthpiece: nothing to send (pass text or pipe it in)\n${USAGE}\n`);
      return 2;
    }
  }
  try {
    const { status } = submit
      ? await deps.client.submitReply({ id: entry.id })
      : await deps.client.reply({ id: entry.id, text });
    if (status === "submitted") {
      io.out(`submitted to ${name}\n`);
      return 0;
    }
    io.out(
      `typed into ${name}, not submitted: run mouthpiece reply --submit ${entry.id.slice(0, 8)}\n`,
    );
    return 3;
  } catch (error) {
    if (error instanceof MouthpieceError && error.reason) {
      io.err(`mouthpiece: reply refused (${error.reason}): ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
