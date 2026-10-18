import { isRecord } from "@mouthpiece/core";
import { approvalText, type HookContext, labelFromCwd, replyRoute } from "@mouthpiece/hook-kit";

export const SOURCE = "codex";

/**
 * Codex CLI hooks (US-014). The hook argument picks the event:
 * stop (Stop), prompt (UserPromptSubmit), interrupt (Interrupt), permission (PermissionRequest).
 * There is no transcript fallback: Codex documents its session format as unstable.
 */
export async function handleHook(event: string, input: unknown, ctx: HookContext): Promise<void> {
  if (ctx.env.MOUTHPIECE_CHILD === "1" || !isRecord(input)) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  const route = replyRoute(ctx.env, "codex");
  switch (event) {
    case "stop": {
      const text = input.last_assistant_message;
      if (typeof text !== "string" || !text.trim()) return;
      await ctx.speak({
        text,
        source: SOURCE,
        conversationId: sessionId,
        label: labelFromCwd(input.cwd),
        kind: "response",
        format: "markdown",
        ...(route && { reply: route }),
      });
      return;
    }
    case "prompt":
    case "interrupt":
      if (sessionId) await ctx.interrupt({ source: SOURCE, conversationId: sessionId });
      return;
    case "permission": {
      // The label is already in the text, so `label` stays unset to avoid a double prefix (US-012).
      const label = labelFromCwd(input.cwd) ?? "Codex";
      const tool = typeof input.tool_name === "string" ? input.tool_name : null;
      await ctx.speak({
        text: approvalText(label, tool),
        source: SOURCE,
        conversationId: sessionId,
        kind: "alert",
        format: "plain",
        ...(route && { reply: route }),
      });
      return;
    }
    default:
      return;
  }
}
