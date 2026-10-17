import { describe, expect, test } from "bun:test";
import type { NormalizedSpeakEvent } from "@mouthpiece/core";
import { type PlayContext, type QueueItem, SpeechQueue } from "./queue.ts";

function event(text: string, extra: Partial<NormalizedSpeakEvent> = {}): NormalizedSpeakEvent {
  return {
    text,
    source: "test",
    conversationId: "c1",
    label: undefined,
    kind: "response",
    priority: "normal",
    mode: undefined,
    format: "plain",
    voice: undefined,
    ...extra,
  };
}

/** A play() whose calls block until released, so tests control timing exactly. */
function controllablePlay() {
  const started: { item: QueueItem; ctx: PlayContext; release: () => void }[] = [];
  const play = (item: QueueItem, ctx: PlayContext) =>
    new Promise<void>((resolve) => {
      started.push({ item, ctx, release: resolve });
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  return { play, started, texts: () => started.map((s) => s.item.event.text) };
}

function setup(nowRef = { t: 0 }) {
  const p = controllablePlay();
  const errors: unknown[] = [];
  const queue = new SpeechQueue({
    play: p.play,
    expireAfterMs: 5 * 60_000,
    labelWindowMs: 10 * 60_000,
    now: () => nowRef.t,
    onError: (e) => errors.push(e),
  });
  return { queue, p, errors, nowRef };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SpeechQueue", () => {
  test("plays items one at a time, FIFO across conversations", async () => {
    const { queue, p } = setup();
    queue.enqueue(event("a", { conversationId: "c1" }));
    queue.enqueue(event("b", { conversationId: "c2" }));
    expect(p.texts()).toEqual(["a"]);
    p.started[0]?.release();
    await tick();
    expect(p.texts()).toEqual(["a", "b"]);
    p.started[1]?.release();
    await queue.idle();
  });

  test("alert jumps ahead of queued items but does not interrupt the current one", async () => {
    const { queue, p } = setup();
    queue.enqueue(event("first", { conversationId: "c1" }));
    queue.enqueue(event("queued", { conversationId: "c2" }));
    queue.enqueue(event("alert", { conversationId: "c3", kind: "alert", priority: "high" }));
    expect(p.started[0]?.ctx.signal.aborted).toBe(false);
    p.started[0]?.release();
    await tick();
    expect(p.texts()).toEqual(["first", "alert"]);
  });

  test("coalesces: a new event replaces the same conversation's queued (not playing) item", async () => {
    const { queue, p } = setup();
    queue.enqueue(event("playing", { conversationId: "c1" }));
    queue.enqueue(event("old", { conversationId: "c1" }));
    queue.enqueue(event("new", { conversationId: "c1" }));
    expect(queue.depth).toBe(1);
    p.started[0]?.release();
    await tick();
    expect(p.texts()).toEqual(["playing", "new"]);
  });

  test("interrupt stops and drops only the matching conversation", async () => {
    const { queue, p } = setup();
    queue.enqueue(event("a1", { conversationId: "a" }));
    queue.enqueue(event("b1", { conversationId: "b" }));
    expect(queue.interrupt("test", "a")).toEqual({ stopped: true, dropped: 0 });
    await tick();
    expect(p.texts()).toEqual(["a1", "b1"]);
    expect(queue.interrupt("test", "a")).toEqual({ stopped: false, dropped: 0 });
  });

  test("interrupt without conversationId covers the whole source", async () => {
    const { queue } = setup();
    queue.enqueue(event("x", { conversationId: "a" }));
    queue.enqueue(event("y", { conversationId: "b" }));
    queue.enqueue(event("z", { source: "other", conversationId: "c" }));
    expect(queue.interrupt("test")).toEqual({ stopped: true, dropped: 1 });
    expect(queue.depth).toBe(1);
  });

  test("stopAll and skip", async () => {
    const { queue, p } = setup();
    queue.enqueue(event("a", { conversationId: "1" }));
    queue.enqueue(event("b", { conversationId: "2" }));
    queue.enqueue(event("c", { conversationId: "3" }));
    expect(queue.skip()).toBe(true);
    await tick();
    expect(p.texts()).toEqual(["a", "b"]);
    expect(queue.stopAll()).toEqual({ stopped: true, dropped: 1 });
    await queue.idle();
    expect(queue.skip()).toBe(false);
  });

  test("queued items expire after expireAfterMs", async () => {
    const { queue, p, nowRef } = setup();
    queue.enqueue(event("now", { conversationId: "1" }));
    queue.enqueue(event("stale", { conversationId: "2" }));
    nowRef.t = 5 * 60_000 + 1;
    p.started[0]?.release();
    await queue.idle();
    expect(p.texts()).toEqual(["now"]);
  });

  test("label is announced only when more than one conversation is active in the window", async () => {
    const { queue, p, nowRef } = setup();
    queue.enqueue(event("solo", { conversationId: "1", label: "web" }));
    expect(p.started[0]?.ctx.announceLabel).toBe(false);
    queue.enqueue(event("second", { conversationId: "2", label: "api" }));
    p.started[0]?.release();
    await tick();
    expect(p.started[1]?.ctx.announceLabel).toBe(true);
    p.started[1]?.release();
    nowRef.t = 11 * 60_000;
    queue.enqueue(event("later", { conversationId: "1", label: "web" }));
    await tick();
    expect(p.started[2]?.ctx.announceLabel).toBe(false);
  });

  test("a failing play is reported and the queue continues", async () => {
    const errors: unknown[] = [];
    const played: string[] = [];
    const queue = new SpeechQueue({
      play: async (item) => {
        played.push(item.event.text);
        if (item.event.text === "bad") throw new Error("boom");
      },
      expireAfterMs: 1000,
      labelWindowMs: 1000,
      onError: (e) => errors.push(e),
    });
    queue.enqueue(event("bad", { conversationId: "1" }));
    queue.enqueue(event("good", { conversationId: "2" }));
    await queue.idle();
    expect(played).toEqual(["bad", "good"]);
    expect(errors).toHaveLength(1);
  });

  test("errors after an abort are not reported", async () => {
    const errors: unknown[] = [];
    const queue = new SpeechQueue({
      play: (_, ctx) =>
        new Promise((_, reject) =>
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      expireAfterMs: 1000,
      labelWindowMs: 1000,
      onError: (e) => errors.push(e),
    });
    queue.enqueue(event("x"));
    queue.skip();
    await queue.idle();
    expect(errors).toEqual([]);
  });
});
