import { expect, test } from "bun:test";
import type { NormalizedSpeakEvent, Summarizer } from "@mouthpiece/core";
import { FirstSentencesSummarizer } from "@mouthpiece/summarizers";
import { createPreparer } from "./prepare.ts";

const long = "I refactored the queue. ".repeat(20); // 480 chars
const ev = (text: string, extra: Partial<NormalizedSpeakEvent> = {}): NormalizedSpeakEvent => ({
  text,
  source: "claude-code",
  conversationId: "c",
  label: undefined,
  kind: "response",
  priority: "normal",
  mode: undefined,
  format: "plain",
  voice: undefined,
  ...extra,
});

function setup(mode: "summary" | "full" | "off", summarizer?: Summarizer) {
  const logs: Record<string, unknown>[] = [];
  const preparer = createPreparer({
    resolveMode: () => mode,
    settings: () => ({
      summarizer,
      fallback: new FirstSentencesSummarizer(60),
      thresholdChars: 300,
    }),
    log: (r) => logs.push(r),
  });
  return { preparer, logs };
}

const fake = (out: string | Error) => {
  const calls: string[] = [];
  const s: Summarizer = {
    name: "fake",
    summarize: async (text) => {
      calls.push(text);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { s, calls };
};

test("full mode speaks the full cleaned text", async () => {
  const { s, calls } = fake("x");
  const p = await setup("full", s).preparer.prepare(ev(long));
  expect(p).toEqual({ mode: "full", full: long.trim(), summary: undefined, spoken: long.trim() });
  expect(calls).toEqual([]);
});

test("summary mode summarizes long responses", async () => {
  const { s } = fake("Short summary.");
  const p = await setup("summary", s).preparer.prepare(ev(long));
  expect(p.spoken).toBe("Short summary.");
  expect(p.summary).toBe("Short summary.");
  expect(p.full).toBe(long.trim());
});

test("short responses and alerts are never summarized", async () => {
  const { s, calls } = fake("x");
  const { preparer } = setup("summary", s);
  expect((await preparer.prepare(ev("Tests pass."))).spoken).toBe("Tests pass.");
  expect((await preparer.prepare(ev(long, { kind: "alert" }))).spoken).toBe(long.trim());
  expect(calls).toEqual([]);
});

test("falls back when the summarizer fails, and logs it", async () => {
  const { s } = fake(new Error("claude exited with 1"));
  const { preparer, logs } = setup("summary", s);
  const p = await preparer.prepare(ev(long));
  expect(p.spoken).toBe("I refactored the queue. I refactored the queue.");
  expect(logs).toContainEqual(expect.objectContaining({ level: "warn", msg: "summary_failed" }));
});

test("no summarizer configured uses the fallback quietly", async () => {
  const { preparer, logs } = setup("summary", undefined);
  expect((await preparer.prepare(ev(long))).summary).toBe(
    "I refactored the queue. I refactored the queue.",
  );
  expect(logs.filter((l) => l.level === "warn")).toEqual([]);
});

test("memoized per event object", async () => {
  const { s, calls } = fake("S.");
  const { preparer } = setup("summary", s);
  const event = ev(long);
  await Promise.all([preparer.prepare(event), preparer.prepare(event)]);
  expect(calls).toHaveLength(1);
});

test("onSummary reports each summarizer call, successful or failed", async () => {
  const records: unknown[] = [];
  let t = 0;
  const make = (s: Summarizer) =>
    createPreparer({
      resolveMode: () => "summary",
      settings: () => ({
        summarizer: s,
        fallback: new FirstSentencesSummarizer(60),
        thresholdChars: 300,
      }),
      log: () => {},
      now: () => (t += 5),
      onSummary: (r) => records.push(r),
    });
  await make(fake("Short summary.").s).prepare(ev(long));
  await make(fake(new Error("boom")).s).prepare(ev(long));
  expect(records).toEqual([
    { backend: "fake", ms: 5, charsIn: long.trim().length, charsOut: 14, ok: true },
    { backend: "fake", ms: 5, charsIn: long.trim().length, charsOut: 0, ok: false },
  ]);
});

test("onSummary is not called when no summarizer runs", async () => {
  const records: unknown[] = [];
  const preparer = createPreparer({
    resolveMode: () => "summary",
    settings: () => ({
      summarizer: undefined,
      fallback: new FirstSentencesSummarizer(60),
      thresholdChars: 300,
    }),
    log: () => {},
    onSummary: (r) => records.push(r),
  });
  await preparer.prepare(ev(long));
  await preparer.prepare(ev("short"));
  expect(records).toEqual([]);
});
