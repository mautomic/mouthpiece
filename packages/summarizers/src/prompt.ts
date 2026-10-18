// The first three lines were validated against claude -p --model haiku (relays rather than answers,
// keeps first person). Re-check summaries with scripts/summary-eval.ts after changing the wording.
export function summaryPrompt(maxChars: number, messageChars: number): string {
  return [
    "You condense a message that an AI coding assistant just wrote to its user into what the assistant would say out loud.",
    'Speak AS the assistant, in first person ("I"), addressing the user as "you".',
    "You are relaying the message, not replying to it: never answer, decide, or add opinions about questions in it.",
    "Say these in this order, skipping any the message doesn't have:",
    "1. The most important things the assistant did or found and how they turned out (for example whether tests pass), most important first. Leave out minor details.",
    "2. End with anything the user needs to do next (for example restart something, run a command, or try a change), including any question or decision the assistant is asking them.",
    "Never leave out a question or something the user needs to do; shorten the rest instead. If there is nothing for the user to do or answer, just end after the results; don't say so.",
    "Say commands in plain words. No code, file paths, commit ids, or exact counts.",
    `Aim for about ${summaryTarget(maxChars, messageChars)} characters, never more. Use short sentences. Output only the spoken text.`,
  ].join("\n");
}

/**
 * Characters to ask for: about 40% of the message (asked for a limit, haiku fills it, even past
 * the message's own length), at least 200, and 60 under `maxChars`, since replies run long and the
 * trim drops whole sentences past it.
 */
export function summaryTarget(maxChars: number, messageChars: number): number {
  const ceiling = Math.max(100, maxChars - 60);
  return Math.min(ceiling, Math.max(200, Math.round(messageChars * 0.4)));
}

export function wrapMessage(text: string): string {
  return `<message>\n${text}\n</message>\n`;
}
