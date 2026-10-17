import type { Mode, NormalizedSpeakEvent } from "@mouthpiece/core";

export interface Prepared {
  mode: Mode;
  full: string;
  summary: string | undefined;
  spoken: string;
}

export interface SpokenRecord {
  id: string;
  event: NormalizedSpeakEvent;
  full: string;
  summary: string | undefined;
  spoken: string;
  at: number;
}

export type ResolveMode = (event: NormalizedSpeakEvent) => Mode;
