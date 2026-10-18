import { ORCA_BIN, OrcaReplyDriver } from "@mouthpiece/adapter-orca";
import type { Config, Exec, ReplyDriver } from "@mouthpiece/core";

/** The reply drivers `mouthpiece start` gives the daemon (PRD §13). */
export function replyDrivers(config: Config, exec?: Exec): ReplyDriver[] {
  return [new OrcaReplyDriver({ orca: config.reply.orca ?? ORCA_BIN, exec })];
}
