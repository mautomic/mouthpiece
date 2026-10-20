import { isRecord } from "@mouthpiece/core";
import { approvalText, type HookContext, labelFromCwd } from "@mouthpiece/hook-kit";

export const SOURCE = "devin";

/**
 * Devin CLI hooks. The hook argument picks the event:
 * stop (Stop), prompt (UserPromptSubmit), permission (PermissionRequest).
 * Devin's payloads carry no `cwd`; the project directory is the DEVIN_PROJECT_DIR env var.
 * `Stop` includes `last_assistant_message`, so there is no transcript fallback.
 */
export async function handleHook(event: string, input: unknown, ctx: HookContext): Promise<void> {
  if (ctx.env.MOUTHPIECE_CHILD === "1" || !isRecord(input)) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  const label = labelFromCwd(ctx.env.DEVIN_PROJECT_DIR);
  switch (event) {
    case "stop": {
      const text = input.last_assistant_message;
      if (typeof text !== "string" || !text.trim()) return;
      await ctx.speak({
        text,
        source: SOURCE,
        conversationId: sessionId,
        label,
        kind: "response",
        format: "markdown",
      });
      return;
    }
    case "prompt":
      if (sessionId) await ctx.interrupt({ source: SOURCE, conversationId: sessionId });
      return;
    case "permission": {
      // The label is already in the text, so `label` stays unset to avoid a double prefix (US-012).
      const tool = typeof input.tool_name === "string" ? input.tool_name : null;
      await ctx.speak({
        text: approvalText(label ?? "Devin", tool),
        source: SOURCE,
        conversationId: sessionId,
        kind: "alert",
        format: "plain",
      });
      return;
    }
    default:
      return;
  }
}
