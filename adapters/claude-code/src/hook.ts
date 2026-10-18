import { isRecord } from "@mouthpiece/core";
import { approvalText, type HookContext, labelFromCwd, replyRoute } from "@mouthpiece/hook-kit";

export const SOURCE = "claude-code";

/** Kept for existing callers; the hook runtime's context. */
export type HookDeps = HookContext;

export async function handleHook(event: string, input: unknown, deps: HookContext): Promise<void> {
  if (deps.env.MOUTHPIECE_CHILD === "1" || !isRecord(input)) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  const route = replyRoute(deps.env, "claude");
  switch (event) {
    case "stop": {
      const text = await assistantText(input, deps);
      if (!text) return;
      await deps.speak({
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
      if (sessionId) await deps.interrupt({ source: SOURCE, conversationId: sessionId });
      return;
    case "notify": {
      // The label is already in the text, so `label` stays unset to avoid a double prefix (US-012).
      const text = notificationText(input, labelFromCwd(input.cwd) ?? "Claude Code");
      if (!text) return;
      await deps.speak({
        text,
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

function notificationText(input: Record<string, unknown>, label: string): string | null {
  switch (input.notification_type) {
    case "permission_prompt": {
      const tool =
        typeof input.message === "string"
          ? /permission to use ([\w.:-]+)/i.exec(input.message)?.[1]
          : undefined;
      return approvalText(label, tool);
    }
    case "idle_prompt":
      return `${label} is waiting for you.`;
    default:
      return null;
  }
}

async function assistantText(
  input: Record<string, unknown>,
  deps: HookContext,
): Promise<string | null> {
  const direct = input.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;
  if (typeof input.transcript_path !== "string") return null;
  try {
    return lastAssistantTextFromTranscript(await deps.readFile(input.transcript_path));
  } catch {
    return null;
  }
}

/** Fallback only: the transcript format is undocumented (PRD §4.2). */
export function lastAssistantTextFromTranscript(jsonl: string): string | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: unknown;
    try {
      record = JSON.parse(lines[i] ?? "");
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "assistant" || !isRecord(record.message)) continue;
    const content = record.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (b): b is { type: "text"; text: string } =>
          isRecord(b) && b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}
