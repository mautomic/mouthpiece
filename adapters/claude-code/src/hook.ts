import { basename } from "node:path";
import { type Env, type InterruptRequest, isRecord, type SpeakEvent } from "@mouthpiece/core";

export const SOURCE = "claude-code";

export interface HookDeps {
  speak(event: SpeakEvent): Promise<unknown>;
  interrupt(request: InterruptRequest): Promise<unknown>;
  readFile(path: string): Promise<string>;
  env: Env;
}

export async function handleHook(event: string, input: unknown, deps: HookDeps): Promise<void> {
  if (deps.env.MOUTHPIECE_CHILD === "1" || !isRecord(input)) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  switch (event) {
    case "stop": {
      const text = await assistantText(input, deps);
      if (!text) return;
      await deps.speak({
        text,
        source: SOURCE,
        conversationId: sessionId,
        label: typeof input.cwd === "string" ? basename(input.cwd) : undefined,
        kind: "response",
        format: "markdown",
      });
      return;
    }
    case "prompt":
      if (sessionId) await deps.interrupt({ source: SOURCE, conversationId: sessionId });
      return;
    case "notify": {
      // The label is already in the text, so `label` stays unset to avoid a double prefix (US-012).
      const label = typeof input.cwd === "string" ? basename(input.cwd) : "Claude Code";
      let text: string | undefined;
      if (input.notification_type === "permission_prompt") {
        const tool =
          typeof input.message === "string"
            ? /permission to use ([\w.:-]+)/i.exec(input.message)?.[1]
            : undefined;
        text = tool
          ? `${label} needs your approval to use ${tool}.`
          : `${label} needs your approval.`;
      } else if (input.notification_type === "idle_prompt") {
        text = `${label} is waiting for you.`;
      }
      if (text) {
        await deps.speak({
          text,
          source: SOURCE,
          conversationId: sessionId,
          kind: "alert",
          format: "plain",
        });
      }
      return;
    }
    default:
      return;
  }
}

async function assistantText(
  input: Record<string, unknown>,
  deps: HookDeps,
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
