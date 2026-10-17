import { expect, test } from "bun:test";
import type { NormalizedSpeakEvent, TtsProvider } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { FirstSentencesSummarizer } from "@mouthpiece/summarizers";
import { FakePlayer } from "./fake-player.ts";
import { createPreparer } from "./prepare.ts";
import type { QueueItem } from "./queue.ts";
import { createSpeaker, skipReason } from "./speaker.ts";
import type { SpokenRecord } from "./types.ts";

function item(text: string, extra: Partial<NormalizedSpeakEvent> = {}): QueueItem {
  return {
    id: "1",
    enqueuedAt: 0,
    event: {
      text,
      source: "test",
      conversationId: "c",
      label: "web",
      kind: "response",
      priority: "normal",
      mode: undefined,
      format: "markdown",
      voice: undefined,
      ...extra,
    },
  };
}
const ctx = (announceLabel = false, signal = new AbortController().signal) => ({
  announceLabel,
  signal,
});
const prepare = createPreparer({
  resolveMode: () => "full",
  settings: () => ({
    summarizer: undefined,
    fallback: new FirstSentencesSummarizer(350),
    thresholdChars: 300,
  }),
  log: () => {},
}).prepare;

test("cleans markdown, prefixes the label when asked, and plays chunk by chunk", async () => {
  const provider = new FakeProvider({ maxCharsPerRequest: 1000 });
  const player = new FakePlayer();
  const logs: Record<string, unknown>[] = [];
  await createSpeaker({ provider, player, log: (r) => logs.push(r), now: () => 42, prepare })(
    item("## Done\nI **fixed** the bug. Tests pass."),
    ctx(true),
  );
  expect(player.played).toEqual(["web: Done.", "I fixed the bug. Tests pass."]);
  expect(logs).toContainEqual(
    expect.objectContaining({ msg: "first_audio", id: "1", latencyMs: 42 }),
  );
});

test("plain format skips cleaning", async () => {
  const player = new FakePlayer();
  await createSpeaker({ provider: new FakeProvider(), player, log: () => {}, prepare })(
    item("**raw**", { format: "plain" }),
    ctx(),
  );
  expect(player.played).toEqual(["**raw**"]);
});

test("abort during prefetch plays nothing more and leaks no rejection", async () => {
  const controller = new AbortController();
  const provider = new FakeProvider({ delayMs: 30 });
  const player = new FakePlayer({ durationMs: 10 });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  setTimeout(() => controller.abort(), 45);
  await createSpeaker({ provider, player, log: () => {}, prepare })(
    item("One. Two. Three. Four."),
    ctx(false, controller.signal),
  );
  await Bun.sleep(100);
  process.off("unhandledRejection", onUnhandled);
  expect(player.played.length).toBeLessThan(2);
  expect(unhandled).toEqual([]);
});

test("continues with later chunks after a chunk fails mid-stream", async () => {
  const provider = new FakeProvider({
    maxCharsPerRequest: 12,
    failMidStream: (t) => t.startsWith("Bad"),
  });
  const player = new FakePlayer();
  const logs: Record<string, unknown>[] = [];
  await createSpeaker({ provider, player, log: (r) => logs.push(r), prepare })(
    item("Good first. Bad second. Good third.", { format: "plain" }),
    ctx(),
  );
  expect(player.played).toEqual(["Good first.", "Good third."]);
  expect(logs).toContainEqual(
    expect.objectContaining({ level: "error", msg: "chunk_failed", chunk: 1 }),
  );
});

test("continues with later chunks after a chunk fails to synthesize", async () => {
  const provider = new FakeProvider({ maxCharsPerRequest: 12 });
  const failing: TtsProvider = {
    name: "fails-on-bad",
    maxCharsPerRequest: 12,
    pricePerMillionChars: 0,
    synthesize: (text, options) =>
      text.startsWith("Bad")
        ? Promise.reject(new Error("boom"))
        : provider.synthesize(text, options),
  };
  const player = new FakePlayer();
  const logs: Record<string, unknown>[] = [];
  await createSpeaker({ provider: failing, player, log: (r) => logs.push(r), prepare })(
    item("Good first. Bad second. Good third.", { format: "plain" }),
    ctx(),
  );
  expect(player.played).toEqual(["Good first.", "Good third."]);
  expect(logs).toContainEqual(
    expect.objectContaining({ level: "error", msg: "chunk_failed", chunk: 1 }),
  );
});

test("skipReason filters trivial responses but never alerts", () => {
  const filter = { minChars: 20, trivial: ["done"] };
  expect(skipReason(item("Done.").event, filter)).toBe("trivial");
  expect(skipReason(item("Done.", { kind: "alert" }).event, filter)).toBeNull();
  expect(skipReason(item("A meaningful response with detail.").event, filter)).toBeNull();
});

test("speaks the prepared summary, records history, and tags synthesis with the source", async () => {
  const provider = new FakeProvider();
  const player = new FakePlayer();
  const records: SpokenRecord[] = [];
  const prepare = async () => ({
    mode: "summary" as const,
    full: "Full text.",
    summary: "Sum.",
    spoken: "Sum.",
  });
  await createSpeaker({
    provider,
    player,
    log: () => {},
    prepare,
    onSpoken: (r) => records.push(r),
  })(item("ignored"), ctx());
  expect(player.played).toEqual(["Sum."]);
  expect(records[0]).toMatchObject({
    id: "1",
    full: "Full text.",
    summary: "Sum.",
    spoken: "Sum.",
  });
  expect(provider.options[0]?.tag).toBe("test");
});

test("abort while preparing plays nothing", async () => {
  const c = new AbortController();
  const player = new FakePlayer();
  const prepare = async () => {
    c.abort();
    return { mode: "full" as const, full: "x", summary: undefined, spoken: "Something to say." };
  };
  await createSpeaker({ provider: new FakeProvider(), player, log: () => {}, prepare })(
    item("x"),
    ctx(false, c.signal),
  );
  expect(player.played).toEqual([]);
});
