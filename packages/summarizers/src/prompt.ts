// This exact wording was validated against claude -p --model haiku (relays rather than answers, keeps first person).
export const SUMMARY_SYSTEM_PROMPT = [
  "You condense a message that an AI coding assistant just wrote to its user into what the assistant would say out loud.",
  'Speak AS the assistant, in first person ("I"), addressing the user as "you".',
  "You are relaying the message, not replying to it: never answer, decide, or add opinions about questions in it.",
  "Put any question or decision the assistant is asking the user first, then the outcome.",
  "1 to 3 short sentences, at most 350 characters. No code, file paths, or line counts. Output only the spoken text.",
].join("\n");

export function wrapMessage(text: string): string {
  return `<message>\n${text}\n</message>\n`;
}
