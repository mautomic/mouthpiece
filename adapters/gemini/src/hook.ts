import { isRecord } from "@mouthpiece/core";
import { approvalText, type HookContext, labelFromCwd } from "@mouthpiece/hook-kit";

export const SOURCE = "gemini";

/**
 * Gemini CLI hooks (US-014). The hook argument picks the event:
 * stop (AfterAgent), prompt (BeforeAgent), notify (Notification).
 * Gemini runs hooks synchronously and treats any output or a non-zero exit as a result,
 * so everything here must stay silent; hook-kit guarantees that.
 */
export async function handleHook(event: string, input: unknown, ctx: HookContext): Promise<void> {
  if (ctx.env.MOUTHPIECE_CHILD === "1" || !isRecord(input)) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  switch (event) {
    case "stop": {
      const text = input.prompt_response;
      if (typeof text !== "string" || !text.trim()) return;
      await ctx.speak({
        text,
        source: SOURCE,
        conversationId: sessionId,
        label: labelFromCwd(input.cwd),
        kind: "response",
        format: "markdown",
      });
      return;
    }
    case "prompt":
      if (sessionId) await ctx.interrupt({ source: SOURCE, conversationId: sessionId });
      return;
    case "notify": {
      if (input.notification_type !== "ToolPermission") return;
      // The label is already in the text, so `label` stays unset to avoid a double prefix (US-012).
      const label = labelFromCwd(input.cwd) ?? "Gemini";
      await ctx.speak({
        text: approvalText(label, toolName(input.details)),
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

function toolName(details: unknown): string | null {
  if (!isRecord(details)) return null;
  for (const v of [details.toolName, details.name]) if (typeof v === "string" && v) return v;
  return null;
}
