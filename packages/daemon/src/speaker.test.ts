import { expect, test } from "bun:test";
import {
  type AudioClip,
  type ChunkHint,
  collectChunks,
  type NormalizedSpeakEvent,
  type Player,
  type SynthesizeOptions,
  singleChunk,
  type TtsProvider,
} from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { FirstSentencesSummarizer } from "@mouthpiece/summarizers";
import { FakePlayer } from "./fake-player.ts";
import { createPreparer } from "./prepare.ts";
import type { PlayContext, QueueItem } from "./queue.ts";
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
      verbatim: false,
      announce: "auto",
      ...extra,
    },
  };
}
const ctx = (
  announceLabel = false,
  signal = new AbortController().signal,
  extra: Partial<PlayContext> = {},
): PlayContext => ({
  announceLabel,
  signal,
  startChunk: 0,
  onChunk: () => {},
  ...extra,
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

test("a provider's chunking hint: withBreaks for a player with breaks, gapless for the stream player", async () => {
  const chunking = {
    withBreaks: { firstChars: 40, targetChars: 30 },
    gapless: { targetChars: 30 },
  };
  const text = "I fixed it. Tests pass. Check is green. Docs updated too.";
  const withBreaks = new FakeProvider({ chunking });
  await createSpeaker({ provider: withBreaks, player: new FakePlayer(), log: () => {}, prepare })(
    item(text, { format: "plain" }),
    ctx(),
  );
  expect(withBreaks.calls).toEqual([
    "I fixed it. Tests pass. Check is green.",
    "Docs updated too.",
  ]);

  const gapless = new FakeProvider({ chunking });
  const player = new FakePlayer({ gapless: true });
  await createSpeaker({ provider: gapless, player, log: () => {}, prepare })(
    item(text, { format: "plain" }),
    ctx(),
  );
  expect(gapless.calls).toEqual([
    "I fixed it.",
    "Tests pass. Check is green.",
    "Docs updated too.",
  ]);
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

test("a verbatim response is never trivial, unless nothing speakable is left", () => {
  const filter = { minChars: 20, trivial: ["done"] };
  expect(skipReason(item("Done.", { verbatim: true }).event, filter)).toBeNull();
  expect(skipReason(item("No open positions.", { verbatim: true }).event, filter)).toBeNull();
  expect(skipReason(item("   ", { verbatim: true }).event, filter)).toBe("trivial");
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

test("passes the event's voice and label to the provider with every chunk", async () => {
  const provider = new FakeProvider({ maxCharsPerRequest: 12 });
  await createSpeaker({ provider, player: new FakePlayer(), log: () => {}, prepare })(
    item("First one. Second one.", { format: "plain", voice: "Samantha", label: "api" }),
    ctx(),
  );
  expect(provider.options).toHaveLength(2);
  for (const options of provider.options) {
    expect(options).toMatchObject({ voice: "Samantha", label: "api", tag: "test" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  }
});

test("an event without voice or label leaves both undefined", async () => {
  const provider = new FakeProvider();
  await createSpeaker({ provider, player: new FakePlayer(), log: () => {}, prepare })(
    item("Hello.", { label: undefined }),
    ctx(),
  );
  expect(provider.options[0]?.voice).toBeUndefined();
  expect(provider.options[0]?.label).toBeUndefined();
});

const FOUR_CHUNKS = "Alpha one. Bravo two. Charlie 3. Delta four.";

/** A player that logs each clip's text into a shared timeline. */
function timelinePlayer(timeline: string[]): Player {
  return {
    play: async (clip) => {
      timeline.push(`play:${new TextDecoder().decode(await collectChunks(clip.chunks))}`);
    },
  };
}

test("reports each chunk before playing it", async () => {
  const timeline: string[] = [];
  await createSpeaker({
    provider: new FakeProvider({ maxCharsPerRequest: 12 }),
    player: timelinePlayer(timeline),
    log: () => {},
    prepare,
  })(
    item(FOUR_CHUNKS, { format: "plain" }),
    ctx(false, undefined, { onChunk: (i) => timeline.push(`chunk:${i}`) }),
  );
  expect(timeline).toEqual([
    "chunk:0",
    "play:Alpha one.",
    "chunk:1",
    "play:Bravo two.",
    "chunk:2",
    "play:Charlie 3.",
    "chunk:3",
    "play:Delta four.",
  ]);
});

test("starts from startChunk without synthesizing the earlier chunks (US-022)", async () => {
  const provider = new FakeProvider({ maxCharsPerRequest: 12 });
  const timeline: string[] = [];
  await createSpeaker({ provider, player: timelinePlayer(timeline), log: () => {}, prepare })(
    item(FOUR_CHUNKS, { format: "plain" }),
    ctx(false, undefined, { startChunk: 2, onChunk: (i) => timeline.push(`chunk:${i}`) }),
  );
  expect(provider.calls).toEqual(["Charlie 3.", "Delta four."]);
  expect(timeline).toEqual(["chunk:2", "play:Charlie 3.", "chunk:3", "play:Delta four."]);
});

test("a resumed item keeps the label prefix in chunk 0, so chunk indices line up", async () => {
  const provider = new FakeProvider({ maxCharsPerRequest: 12 });
  const it = item("Bravo two. Charlie 3. Delta four.", { format: "plain", label: "web" });
  const whole = new FakePlayer();
  await createSpeaker({ provider, player: whole, log: () => {}, prepare })(it, ctx(true));
  expect(whole.played[0]).toStartWith("web:");
  const resumed = new FakePlayer();
  await createSpeaker({ provider, player: resumed, log: () => {}, prepare })(
    it,
    ctx(true, undefined, { startChunk: 1 }),
  );
  expect(resumed.played).toEqual(whole.played.slice(1));
});

test("a resumed item does not call onSpoken again or log first_audio", async () => {
  const records: SpokenRecord[] = [];
  const logs: Record<string, unknown>[] = [];
  await createSpeaker({
    provider: new FakeProvider({ maxCharsPerRequest: 12 }),
    player: new FakePlayer(),
    log: (r) => logs.push(r),
    prepare,
    onSpoken: (r) => records.push(r),
  })(item(FOUR_CHUNKS, { format: "plain" }), ctx(false, undefined, { startChunk: 1 }));
  expect(records).toEqual([]);
  expect(logs.filter((l) => l.msg === "first_audio")).toEqual([]);
});

test("an item resumed from chunk 0 (paused before its first chunk) is recorded once", async () => {
  const records: SpokenRecord[] = [];
  const paused = new AbortController();
  const player = new FakePlayer();
  const speak = createSpeaker({
    provider: new FakeProvider(),
    player,
    log: () => {},
    prepare,
    onSpoken: (r) => {
      records.push(r);
      paused.abort(); // the pause lands after the record, before chunk 0 plays
    },
  });
  const it = item("Hello there.", { format: "plain" });
  await speak(it, ctx(false, paused.signal));
  expect(player.played).toEqual([]);
  await speak(it, ctx());
  expect(player.played).toEqual(["Hello there."]);
  expect(records).toHaveLength(1);
});

test("a startChunk past the last chunk plays nothing", async () => {
  const provider = new FakeProvider({ maxCharsPerRequest: 12 });
  const player = new FakePlayer();
  await createSpeaker({ provider, player, log: () => {}, prepare })(
    item("Alpha one.", { format: "plain" }),
    ctx(false, undefined, { startChunk: 5 }),
  );
  expect(provider.calls).toEqual([]);
  expect(player.played).toEqual([]);
});

test("a pause while the next chunk is still synthesizing resumes from that chunk", async () => {
  const fake = new FakeProvider({ maxCharsPerRequest: 12 });
  let reachedBravo: () => void = () => {};
  const bravoStarted = new Promise<void>((r) => {
    reachedBravo = r;
  });
  const slow: TtsProvider = {
    name: "slow-bravo",
    maxCharsPerRequest: 12,
    pricePerMillionChars: 0,
    synthesize: async (text, options) => {
      if (text.startsWith("Bravo")) {
        reachedBravo();
        await new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
      return fake.synthesize(text, options);
    },
  };
  const reported: number[] = [];
  const pause = new AbortController();
  const player = new FakePlayer();
  const done = createSpeaker({ provider: slow, player, log: () => {}, prepare })(
    item(FOUR_CHUNKS, { format: "plain" }),
    ctx(false, pause.signal, { onChunk: (i) => reported.push(i) }),
  );
  await bravoStarted;
  await Bun.sleep(5); // chunk 0 has played; chunk 1 is still synthesizing
  pause.abort();
  await done;
  expect(player.played).toEqual(["Alpha one."]);
  expect(reported.at(-1)).toBe(1);
});

/** A provider whose chunk limit can change between plays, like a config reload swapping chains. */
function switchableProvider(maxCharsPerRequest: number) {
  const fake = new FakeProvider({ maxCharsPerRequest: 100_000 });
  const provider = {
    name: "switch",
    maxCharsPerRequest,
    pricePerMillionChars: 0,
    synthesize: (text: string, options?: Parameters<TtsProvider["synthesize"]>[1]) =>
      fake.synthesize(text, options),
  } satisfies TtsProvider;
  return { provider, calls: fake.calls };
}

const SENTENCES = [
  "Sentence number zero is here.",
  "Sentence number one is here.",
  "Sentence number two is here.",
  "Sentence number three is here.",
  "Sentence number four is here.",
  "Sentence number five is here.",
  "Sentence number six is here.",
];

/** Plays `it` from `startChunk` until chunk `pauseAt` is reached, then aborts (a pause). */
async function playUntilPause(
  speak: ReturnType<typeof createSpeaker>,
  it: QueueItem,
  { startChunk = 0, pauseAt }: { startChunk?: number; pauseAt: number },
) {
  const pause = new AbortController();
  await speak(
    it,
    ctx(false, pause.signal, {
      startChunk,
      onChunk: (i) => {
        if (i === pauseAt) pause.abort();
      },
    }),
  );
}

test("a chain change while paused resumes from the same chunk list, not a re-chunked one", async () => {
  const { provider } = switchableProvider(40);
  const player = new FakePlayer();
  const speak = createSpeaker({ provider, player, log: () => {}, prepare });
  const it = item(SENTENCES.join(" "), { format: "plain" });
  await playUntilPause(speak, it, { pauseAt: 4 });
  expect(player.played).toEqual(SENTENCES.slice(0, 4));

  provider.maxCharsPerRequest = 4000; // re-chunked, the whole text would be one chunk
  await speak(it, ctx(false, undefined, { startChunk: 4 }));
  expect(player.played).toEqual(SENTENCES);
});

test("a frozen chunk longer than the new provider's limit is re-split from that chunk on", async () => {
  const { provider, calls } = switchableProvider(4000);
  const player = new FakePlayer();
  const speak = createSpeaker({ provider, player, log: () => {}, prepare });
  // Chunk 0 is the first sentence alone; chunk 1 packs the rest (~200 chars).
  const it = item(`Short one. ${SENTENCES.join(" ")}`, { format: "plain" });
  await playUntilPause(speak, it, { pauseAt: 1 });
  expect(player.played).toEqual(["Short one."]);

  provider.maxCharsPerRequest = 40;
  // Resumed at chunk 1, which is now re-split into one chunk per sentence; pause again at
  // the third of those (index 3).
  await playUntilPause(speak, it, { startChunk: 1, pauseAt: 3 });
  expect(player.played).toEqual(["Short one.", ...SENTENCES.slice(0, 2)]);

  // The second resume uses the re-split list, so index 3 is the same chunk as before.
  await speak(it, ctx(false, undefined, { startChunk: 3 }));
  expect(player.played).toEqual(["Short one.", ...SENTENCES]);
  // After the two first-play calls (chunk 0, and chunk 1 prefetched), every chunk fits.
  expect(calls.slice(2).every((c) => c.length <= 40)).toBe(true);
});

/**
 * A local-model stand-in: renders `renderMsPerChar` per character, then returns a silent 1 kHz
 * float WAV of `audioMsPerChar` per character. Records when each chunk finished rendering.
 */
class TimedWavProvider {
  readonly name = "local";
  readonly maxCharsPerRequest = 400;
  readonly pricePerMillionChars = 0;
  readonly chunking: ChunkHint = {
    withBreaks: { firstChars: 400, targetChars: 400 },
    gapless: { targetChars: 30 },
  };
  readonly rendered = new Map<string, number>();
  constructor(
    private readonly renderMsPerChar: number,
    private readonly audioMsPerChar: number,
  ) {}
  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<AudioClip> {
    await Bun.sleep(text.length * this.renderMsPerChar);
    opts.signal?.throwIfAborted();
    this.rendered.set(text, performance.now());
    const frames = text.length * this.audioMsPerChar; // 1 kHz: one frame per millisecond
    const view = new DataView(new ArrayBuffer(44 + frames * 4));
    const ascii = (o: number, t: string) =>
      [...t].forEach((c, i) => {
        view.setUint8(o + i, c.charCodeAt(0));
      });
    ascii(0, "RIFF");
    view.setUint32(4, 36 + frames * 4, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 1_000, true);
    view.setUint32(28, 4_000, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 32, true);
    ascii(36, "data");
    view.setUint32(40, frames * 4, true);
    return { format: "wav", chunks: singleChunk(new Uint8Array(view.buffer)) };
  }
}

/** A gap-free player that records when each clip starts, and returns at once. */
class StartTimes {
  readonly gapless = true;
  readonly starts: number[] = [];
  async play(): Promise<void> {
    this.starts.push(performance.now());
  }
}

test("a short opener waits so the next chunk is ready in time", async () => {
  // 4 ms of rendering and 20 ms of audio per character: "Hi." plays 60 ms; the next takes ~250 ms to render.
  const opener = "Hi.";
  const next = "This second sentence takes a good while to render, really.";
  const provider = new TimedWavProvider(4, 20);
  const player = new StartTimes();
  await createSpeaker({ provider, player, log: () => {}, prepare, now: () => performance.now() })(
    item(`${opener} ${next}`, { format: "plain" }),
    ctx(),
  );
  const openerStart = player.starts[0] ?? 0;
  // Playback reaches the second chunk 60 ms after the opener starts; it must be rendered by then.
  expect(provider.rendered.get(next) ?? Infinity).toBeLessThanOrEqual(openerStart + 60 + 10);
});

test("a long first sentence starts as soon as it is rendered", async () => {
  const first = "This first sentence is long enough to cover the next render.";
  const second = "And this second one is about the same length as the first.";
  const provider = new TimedWavProvider(4, 20);
  const player = new StartTimes();
  await createSpeaker({ provider, player, log: () => {}, prepare, now: () => performance.now() })(
    item(`${first} ${second}`, { format: "plain" }),
    ctx(),
  );
  expect(player.starts[0] ?? Infinity).toBeLessThan(provider.rendered.get(second) ?? 0);
});

test("without a gap-free player the speaker keeps its one-chunk prefetch and no gate", async () => {
  const provider = new TimedWavProvider(4, 20);
  const player = new FakePlayer();
  await createSpeaker({ provider, player, log: () => {}, prepare })(
    item("Hi. This one is the second sentence of the item.", { format: "plain" }),
    ctx(),
  );
  expect(player.played).toHaveLength(1); // withBreaks packs the whole item into one clip
});

test("rendering ahead, a chunk whose stream fails is skipped and nothing rejects unhandled", async () => {
  const provider = new FakeProvider({
    chunking: { withBreaks: { firstChars: 400, targetChars: 400 }, gapless: { targetChars: 1 } },
    failMidStream: (t) => t.startsWith("Bad"),
  });
  const player = new FakePlayer({ gapless: true });
  const logs: Record<string, unknown>[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await createSpeaker({ provider, player, log: (r) => logs.push(r), prepare })(
      item("Good first. Bad second. Good third. Good four.", { format: "plain" }),
      ctx(),
    );
    await Bun.sleep(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(player.played).toEqual(["Good first.", "Good third.", "Good four."]);
  expect(logs).toContainEqual(
    expect.objectContaining({ level: "error", msg: "chunk_failed", chunk: 1 }),
  );
  expect(unhandled).toEqual([]);
});
