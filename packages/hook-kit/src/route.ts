import { type Env, parseReplyRoute, type ReplyRoute } from "@mouthpiece/core";

/** The reply route for a hook running in an Orca terminal (PRD §13); undefined elsewhere. */
export function replyRoute(env: Env, agent: string): ReplyRoute | undefined {
  return parseReplyRoute({ via: "orca", target: env.ORCA_TERMINAL_HANDLE, agent });
}
