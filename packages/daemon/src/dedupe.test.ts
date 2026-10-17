import { expect, test } from "bun:test";
import type { NormalizedSpeakEvent } from "@mouthpiece/core";
import { AlertDeduper } from "./dedupe.ts";

const alert = (text: string, kind: "alert" | "response" = "alert") =>
  ({
    text,
    source: "s",
    conversationId: "c",
    label: undefined,
    kind,
    priority: "high",
    mode: undefined,
    format: "plain",
  }) as NormalizedSpeakEvent;

test("same alert within the window is a duplicate; responses never are", () => {
  let t = 0;
  const d = new AlertDeduper(60_000, () => t);
  expect(d.isDuplicate(alert("needs approval"))).toBe(false);
  expect(d.isDuplicate(alert("needs approval"))).toBe(true);
  expect(d.isDuplicate(alert("other"))).toBe(false);
  expect(d.isDuplicate(alert("r", "response"))).toBe(false);
  expect(d.isDuplicate(alert("r", "response"))).toBe(false);
  t = 60_001;
  expect(d.isDuplicate(alert("needs approval"))).toBe(false);
});
