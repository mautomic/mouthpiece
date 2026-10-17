import type { Summarizer } from "@mouthpiece/core";
import { trimToSentences } from "./trim.ts";

/** Zero-cost fallback: the leading sentences of the (already cleaned) text. */
export class FirstSentencesSummarizer implements Summarizer {
  readonly name = "first-sentences";

  constructor(private readonly maxChars: number) {}

  async summarize(text: string): Promise<string> {
    return trimToSentences(text, this.maxChars);
  }
}
