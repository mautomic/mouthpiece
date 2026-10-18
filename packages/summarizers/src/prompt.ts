// The first three lines were validated against claude -p --model haiku (relays rather than answers,
// keeps first person). Re-check summaries with scripts/summary-eval.ts after changing the wording.
export function summaryPrompt(maxChars: number): string {
  // Aim below the limit: replies run long, and trimToSentences drops whole sentences past it.
  const target = Math.max(100, maxChars - 60);
  return [
    "You condense a message that an AI coding assistant just wrote to its user into what the assistant would say out loud.",
    'Speak AS the assistant, in first person ("I"), addressing the user as "you".',
    "You are relaying the message, not replying to it: never answer, decide, or add opinions about questions in it.",
    "Say first any question or decision the assistant is asking the user, and anything the user needs to do next (for example restart something, run a command, or try a change). Then say what the assistant did and how it turned out (for example whether tests pass).",
    "Never leave out a question or something the user needs to do; shorten the rest instead.",
    "Say commands in plain words. No code, file paths, commit ids, or exact counts.",
    `1 to 4 short sentences, at most ${target} characters. Output only the spoken text.`,
  ].join("\n");
}

export function wrapMessage(text: string): string {
  return `<message>\n${text}\n</message>\n`;
}
