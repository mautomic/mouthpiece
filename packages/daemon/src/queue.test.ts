import { describe, expect, test } from "bun:test";
import type { NormalizedSpeakEvent } from "@mouthpiece/core";
import {
  NOTICE_SOURCE,
  type PlayContext,
  type QueueItem,
  type QueueTimers,
  SpeechQueue,
} from "./queue.ts";

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

  test("configure changes expiry for the next pump", async () => {
    const { queue, p, nowRef } = setup();
    queue.enqueue(event("playing", { conversationId: "1" }));
    queue.enqueue(event("old", { conversationId: "2" }));
    nowRef.t = 11;
    queue.configure({ expireAfterMs: 10, labelWindowMs: 10 * 60_000 });
    p.started[0]?.release();
    await queue.idle();
    expect(p.texts()).toEqual(["playing"]);
  });

  test("configure changes the label window", async () => {
    const { queue, p, nowRef } = setup();
    queue.enqueue(event("first", { conversationId: "1", label: "web" }));
    p.started[0]?.release();
    await queue.idle();
    nowRef.t = 100;
    queue.configure({ expireAfterMs: 5 * 60_000, labelWindowMs: 50 });
    queue.enqueue(event("second", { conversationId: "2", label: "api" }));
    expect(p.started[1]?.ctx.announceLabel).toBe(false);
    p.started[1]?.release();
    await queue.idle();
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

  test("a quota notice does not count as another conversation", async () => {
    const { queue, p } = setup();
    queue.enqueue(event("notice", { source: NOTICE_SOURCE, conversationId: "quota-0" }));
    expect(p.started[0]?.ctx.announceLabel).toBe(false);
    p.started[0]?.release();
    await tick();
    queue.enqueue(event("real", { conversationId: "1", label: "web" }));
    await tick();
    expect(p.texts()).toEqual(["notice", "real"]);
    expect(p.started[1]?.ctx.announceLabel).toBe(false);
    p.started[1]?.release();
    await queue.idle();
  });

  test("an unlabeled alert from another session makes a labeled response announce its label", async () => {
    const { queue, p } = setup();
    queue.enqueue(
      event("Claude needs your approval in api", { conversationId: "B", kind: "alert" }),
    );
    p.started[0]?.release();
    await tick();
    queue.enqueue(event("done", { conversationId: "A", label: "web" }));
    await tick();
    expect(p.texts()).toEqual(["Claude needs your approval in api", "done"]);
    expect(p.started[1]?.ctx.announceLabel).toBe(true);
    p.started[1]?.release();
    await queue.idle();
  });

  test("a daemon notice (source NOTICE_SOURCE) does not make a response announce its label", async () => {
    const { queue, p } = setup();
    queue.enqueue(
      event("notice", { source: NOTICE_SOURCE, conversationId: "quota-0", label: "x" }),
    );
    p.started[0]?.release();
    await tick();
    queue.enqueue(event("done", { conversationId: "A", label: "web" }));
    await tick();
    expect(p.started[1]?.ctx.announceLabel).toBe(false);
    p.started[1]?.release();
    await queue.idle();
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

/** A play() that ignores abort until released, so a pause abort races the play promise settling. */
function stubbornPlay() {
  const started: {
    item: QueueItem;
    ctx: PlayContext;
    release: () => void;
    fail: (e: unknown) => void;
  }[] = [];
  const play = (item: QueueItem, ctx: PlayContext) =>
    new Promise<void>((resolve, reject) => {
      started.push({ item, ctx, release: resolve, fail: reject });
    });
  return { play, started };
}

/** Timers the test fires by hand. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  const timers: QueueTimers = {
    set: (fn, ms) => {
      pending.set(++seq, { fn, ms });
      return seq;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    /** Delays of the timers still scheduled. */
    delays: () => [...pending.values()].map((t) => t.ms),
    /** Runs every scheduled timer once. */
    fireAll: () => {
      const due = [...pending.entries()];
      for (const [id] of due) pending.delete(id);
      for (const [, t] of due) t.fn();
    },
  };
}

function pausable(opts: { maxPauseMs?: number; expireAfterMs?: number } = {}) {
  const nowRef = { t: 0 };
  const p = controllablePlay();
  const errors: unknown[] = [];
  const clock = fakeTimers();
  const queue = new SpeechQueue({
    play: p.play,
    expireAfterMs: opts.expireAfterMs ?? 5 * 60_000,
    labelWindowMs: 10 * 60_000,
    maxPauseMs: opts.maxPauseMs ?? 600_000,
    now: () => nowRef.t,
    timers: clock.timers,
    onError: (e) => errors.push(e),
  });
  return { queue, p, errors, nowRef, clock };
}

describe("SpeechQueue pause/resume (US-022)", () => {
  test("pausing mid-item resumes from the reported chunk with the same id", async () => {
    const { queue, p, errors } = pausable();
    const item = queue.enqueue(event("long", { conversationId: "1" }));
    expect(p.started[0]?.ctx.startChunk).toBe(0);
    p.started[0]?.ctx.onChunk(0);
    p.started[0]?.ctx.onChunk(1);
    p.started[0]?.ctx.onChunk(2);
    expect(queue.pause("user")).toEqual({ paused: true, pauseReasons: ["user"] });
    expect(p.started[0]?.ctx.signal.aborted).toBe(true);
    await tick();
    expect(p.started).toHaveLength(1);
    expect(queue.held?.id).toBe(item.id);
    expect(queue.resume("user")).toEqual({ paused: false, pauseReasons: [] });
    expect(p.started).toHaveLength(2);
    expect(p.started[1]?.item.id).toBe(item.id);
    expect(p.started[1]?.ctx.startChunk).toBe(2);
    expect(queue.held).toBeNull();
    p.started[1]?.release();
    await queue.idle();
    expect(errors).toEqual([]);
  });

  test("a pause before any chunk is reported resumes from the play's start chunk", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("long"));
    p.started[0]?.ctx.onChunk(3);
    queue.pause("mic");
    await tick();
    queue.resume("mic");
    expect(p.started[1]?.ctx.startChunk).toBe(3);
    // Paused again before the resumed play reports a chunk: still chunk 3, not 0.
    queue.pause("mic");
    await tick();
    queue.resume("mic");
    expect(p.started[2]?.ctx.startChunk).toBe(3);
  });

  test("a resumed item keeps its label decision", async () => {
    const { queue, p, nowRef } = pausable();
    queue.enqueue(event("other", { conversationId: "2", label: "api" }));
    p.started[0]?.release();
    await tick();
    queue.enqueue(event("labeled", { conversationId: "1", label: "web" }));
    expect(p.started[1]?.ctx.announceLabel).toBe(true);
    queue.pause("user");
    await tick();
    nowRef.t = 11 * 60_000; // the other conversation has left the label window
    queue.resume("user");
    expect(p.started[2]?.ctx.announceLabel).toBe(true);
  });

  test("a pause abort is not reported, does not drop the item, and does not pump", async () => {
    const s = stubbornPlay();
    const errors: unknown[] = [];
    const queue = new SpeechQueue({
      play: s.play,
      expireAfterMs: 1000,
      labelWindowMs: 1000,
      now: () => 0,
      onError: (e) => errors.push(e),
    });
    const a = queue.enqueue(event("a", { conversationId: "1" }));
    queue.enqueue(event("b", { conversationId: "2" }));
    s.started[0]?.ctx.onChunk(1);
    queue.pause("mic");
    s.started[0]?.fail(new Error("aborted by pause"));
    await tick();
    expect(errors).toEqual([]);
    expect(s.started).toHaveLength(1);
    expect(queue.held?.id).toBe(a.id);
    expect(queue.depth).toBe(1);
    queue.resume("mic");
    expect(s.started[1]?.item.id).toBe(a.id);
    expect(s.started[1]?.ctx.startChunk).toBe(1);
  });

  test("resuming before the paused play settles waits for it (no overlap)", async () => {
    const s = stubbornPlay();
    const queue = new SpeechQueue({ play: s.play, expireAfterMs: 1000, labelWindowMs: 1000 });
    queue.enqueue(event("a"));
    s.started[0]?.ctx.onChunk(2);
    queue.pause("mic");
    queue.resume("mic");
    expect(s.started).toHaveLength(1);
    expect(queue.speaking).toBe(false);
    s.started[0]?.release(); // the aborted play finally winds down
    await tick();
    expect(s.started).toHaveLength(2);
    expect(s.started[1]?.ctx.startChunk).toBe(2);
    expect(queue.speaking).toBe(true);
  });

  test("pausing again while the paused play is still settling keeps one held item", async () => {
    const s = stubbornPlay();
    const queue = new SpeechQueue({ play: s.play, expireAfterMs: 1000, labelWindowMs: 1000 });
    queue.enqueue(event("a"));
    s.started[0]?.ctx.onChunk(1);
    queue.pause("mic");
    queue.resume("mic");
    queue.pause("user");
    s.started[0]?.release();
    await tick();
    expect(s.started).toHaveLength(1);
    queue.resume("user");
    expect(s.started).toHaveLength(2);
    expect(s.started[1]?.ctx.startChunk).toBe(1);
  });

  test("onChunk from a play that was paused is ignored", async () => {
    const s = stubbornPlay();
    const queue = new SpeechQueue({ play: s.play, expireAfterMs: 1000, labelWindowMs: 1000 });
    queue.enqueue(event("a"));
    s.started[0]?.ctx.onChunk(1);
    queue.pause("mic");
    s.started[0]?.ctx.onChunk(2); // a late report while winding down
    s.started[0]?.release();
    await tick();
    queue.resume("mic");
    expect(s.started[1]?.ctx.startChunk).toBe(1);
  });

  test("two reasons both need resuming", () => {
    const { queue, p } = pausable();
    queue.pause("mic");
    expect(queue.pause("user")).toEqual({ paused: true, pauseReasons: ["mic", "user"] });
    queue.enqueue(event("x"));
    expect(queue.resume("mic")).toEqual({ paused: true, pauseReasons: ["user"] });
    expect(p.started).toHaveLength(0);
    queue.resume("user");
    expect(p.texts()).toEqual(["x"]);
  });

  test("re-pausing an active reason keeps one entry and restarts its expiry clock", () => {
    const { queue, nowRef } = pausable({ maxPauseMs: 1000 });
    queue.pause("mic");
    nowRef.t = 800;
    expect(queue.pause("mic")).toEqual({ paused: true, pauseReasons: ["mic"] });
    nowRef.t = 1500;
    expect(queue.paused).toBe(true);
    expect(queue.pauseReasons()).toEqual(["mic"]);
  });

  test("resuming an unknown reason is a no-op", () => {
    const { queue, p } = pausable();
    queue.pause("mic");
    queue.enqueue(event("x"));
    expect(queue.resume("user")).toEqual({ paused: true, pauseReasons: ["mic"] });
    expect(p.started).toHaveLength(0);
  });

  test("resuming when not paused does nothing", () => {
    const { queue, p } = pausable();
    queue.enqueue(event("x"));
    expect(queue.resume("user")).toEqual({ paused: false, pauseReasons: [] });
    expect(p.started).toHaveLength(1);
    expect(p.started[0]?.ctx.signal.aborted).toBe(false);
  });

  test("an item queued while paused plays after resume", () => {
    const { queue, p } = pausable();
    queue.pause("user");
    queue.enqueue(event("later"));
    expect(queue.depth).toBe(1);
    expect(p.started).toHaveLength(0);
    queue.resume("user");
    expect(p.texts()).toEqual(["later"]);
    expect(p.started[0]?.ctx.startChunk).toBe(0);
  });

  test("the held item plays first on resume, before even an alert queued while paused", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("held", { conversationId: "1" }));
    queue.pause("user");
    await tick();
    queue.enqueue(event("alert", { conversationId: "2", kind: "alert", priority: "high" }));
    queue.resume("user");
    expect(p.texts()).toEqual(["held", "held"]);
    p.started[1]?.release();
    await tick();
    expect(p.texts()).toEqual(["held", "held", "alert"]);
  });

  test("a newer event from the held item's conversation does not replace it", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("held", { conversationId: "1" }));
    queue.pause("user");
    await tick();
    queue.enqueue(event("newer", { conversationId: "1" }));
    queue.resume("user");
    p.started[1]?.release();
    await tick();
    expect(p.texts()).toEqual(["held", "held", "newer"]);
  });

  test("interrupt while paused drops the held item for good", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("a", { conversationId: "1" }));
    queue.enqueue(event("b", { conversationId: "2" }));
    queue.pause("user");
    await tick();
    expect(queue.interrupt("test", "1")).toEqual({ stopped: true, dropped: 0 });
    expect(queue.held).toBeNull();
    queue.resume("user");
    expect(p.texts()).toEqual(["a", "b"]);
  });

  test("interrupt for another conversation leaves the held item", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("a", { conversationId: "1" }));
    queue.pause("user");
    await tick();
    expect(queue.interrupt("test", "2")).toEqual({ stopped: false, dropped: 0 });
    queue.resume("user");
    expect(p.texts()).toEqual(["a", "a"]);
  });

  test("interrupt while the paused play is still settling drops the held item", async () => {
    const s = stubbornPlay();
    const queue = new SpeechQueue({ play: s.play, expireAfterMs: 1000, labelWindowMs: 1000 });
    queue.enqueue(event("a"));
    queue.pause("user");
    expect(queue.interrupt("test")).toEqual({ stopped: true, dropped: 0 });
    queue.resume("user");
    s.started[0]?.release();
    await queue.idle();
    expect(s.started).toHaveLength(1);
  });

  test("skip while paused drops the held item; the next one plays on resume", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("a", { conversationId: "1" }));
    queue.enqueue(event("b", { conversationId: "2" }));
    queue.pause("user");
    await tick();
    expect(queue.skip()).toBe(true);
    expect(queue.held).toBeNull();
    expect(queue.depth).toBe(1);
    expect(queue.skip()).toBe(false);
    queue.resume("user");
    expect(p.texts()).toEqual(["a", "b"]);
  });

  test("stopAll while paused drops the held item and the queue", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("a", { conversationId: "1" }));
    queue.enqueue(event("b", { conversationId: "2" }));
    queue.pause("user");
    await tick();
    expect(queue.stopAll()).toEqual({ stopped: true, dropped: 1 });
    queue.resume("user");
    await queue.idle();
    expect(p.texts()).toEqual(["a"]);
  });

  test("an expired reason auto-resumes", async () => {
    const { queue, p, nowRef } = pausable({ maxPauseMs: 1000 });
    queue.enqueue(event("a"));
    p.started[0]?.ctx.onChunk(1);
    queue.pause("mic");
    await tick();
    nowRef.t = 1000;
    expect(queue.paused).toBe(true);
    nowRef.t = 1001;
    expect(queue.paused).toBe(false);
    expect(p.started[1]?.ctx.startChunk).toBe(1);
  });

  test("expiry is checked when pauseReasons() is read and when an item is queued", async () => {
    const { queue, p, nowRef } = pausable({ maxPauseMs: 1000 });
    queue.pause("mic");
    queue.enqueue(event("a", { conversationId: "1" }));
    nowRef.t = 2000;
    expect(queue.pauseReasons()).toEqual([]);
    expect(p.texts()).toEqual(["a"]);
    p.started[0]?.release();
    await tick();
    queue.pause("mic");
    nowRef.t = 4000;
    queue.enqueue(event("b", { conversationId: "2" }));
    expect(p.texts()).toEqual(["a", "b"]);
  });

  test("a pause expires on its own timer, with nothing polling (US-022)", async () => {
    const { queue, p, nowRef, clock } = pausable({ maxPauseMs: 1000 });
    queue.enqueue(event("a"));
    p.started[0]?.ctx.onChunk(2);
    queue.pause("mic");
    await tick();
    expect(clock.delays()).toEqual([1001]); // expiry is `older than` maxPauseMs
    nowRef.t = 1001;
    clock.fireAll();
    expect(p.started[1]?.ctx.startChunk).toBe(2); // the held item resumed without any request
    expect(clock.delays()).toEqual([]);
  });

  test("the expiry timer follows the earliest reason and is cleared when none remain", async () => {
    const { queue, nowRef, clock } = pausable({ maxPauseMs: 1000 });
    queue.pause("mic");
    nowRef.t = 400;
    queue.pause("user");
    expect(clock.delays()).toEqual([601]); // mic's expiry, rescheduled on the second pause
    nowRef.t = 1001;
    clock.fireAll();
    expect(queue.pauseReasons()).toEqual(["user"]);
    expect(clock.delays()).toEqual([400]); // user expires at 1401
    queue.resume("user");
    expect(clock.delays()).toEqual([]);

    queue.pause("mic");
    queue.configure({ expireAfterMs: 5 * 60_000, labelWindowMs: 10 * 60_000, maxPauseMs: 50 });
    expect(clock.delays()).toEqual([51]);
  });

  test("a repeated pause restarts the reason's clock and its timer", () => {
    const { queue, nowRef, clock } = pausable({ maxPauseMs: 1000 });
    queue.pause("mic");
    nowRef.t = 900;
    queue.pause("mic");
    expect(clock.delays()).toEqual([1001]);
    nowRef.t = 1100;
    clock.fireAll(); // fired early (e.g. a stale timer): nothing has expired yet
    expect(queue.pauseReasons()).toEqual(["mic"]);
    expect(clock.delays()).toEqual([801]);
  });

  test("only expired reasons are pruned", () => {
    const { queue, nowRef } = pausable({ maxPauseMs: 1000 });
    queue.pause("mic");
    nowRef.t = 500;
    queue.pause("user");
    nowRef.t = 1200;
    expect(queue.pauseReasons()).toEqual(["user"]);
    expect(queue.paused).toBe(true);
  });

  test("configure changes maxPauseMs", () => {
    const { queue, nowRef } = pausable({ maxPauseMs: 1000 });
    queue.configure({ expireAfterMs: 5 * 60_000, labelWindowMs: 10 * 60_000, maxPauseMs: 50 });
    queue.pause("mic");
    nowRef.t = 51;
    expect(queue.paused).toBe(false);
  });

  test("maxPauseMs defaults to ten minutes", () => {
    const nowRef = { t: 0 };
    const queue = new SpeechQueue({
      play: controllablePlay().play,
      expireAfterMs: 1000,
      labelWindowMs: 1000,
      now: () => nowRef.t,
    });
    queue.pause("mic");
    nowRef.t = 600_000;
    expect(queue.paused).toBe(true);
    nowRef.t = 600_001;
    expect(queue.paused).toBe(false);
  });

  test("the held item does not expire while paused; other queued items still do", async () => {
    const { queue, p, nowRef } = pausable({ expireAfterMs: 1000, maxPauseMs: 60_000 });
    queue.enqueue(event("held", { conversationId: "1" }));
    queue.enqueue(event("queued", { conversationId: "2" }));
    queue.pause("user");
    await tick();
    nowRef.t = 5000;
    queue.resume("user");
    expect(p.texts()).toEqual(["held", "held"]);
    p.started[1]?.release();
    await queue.idle();
    expect(p.texts()).toEqual(["held", "held"]);
  });

  test("speaking is true while playing and false while paused", async () => {
    const { queue, p } = pausable();
    expect(queue.speaking).toBe(false);
    queue.enqueue(event("a"));
    expect(queue.speaking).toBe(true);
    queue.pause("user");
    expect(queue.speaking).toBe(false);
    await tick();
    expect(queue.speaking).toBe(false);
    expect(queue.current).toBeNull();
    queue.resume("user");
    expect(queue.speaking).toBe(true);
    p.started[1]?.release();
    await queue.idle();
    expect(queue.speaking).toBe(false);
  });

  test("idle() waits for the held item to finish after resume", async () => {
    const { queue, p } = pausable();
    queue.enqueue(event("a"));
    queue.pause("user");
    await tick();
    let idle = false;
    void queue.idle().then(() => {
      idle = true;
    });
    await tick();
    expect(idle).toBe(false);
    queue.resume("user");
    p.started[1]?.release();
    await tick();
    expect(idle).toBe(true);
  });

  test("pausing while idle holds nothing; idle() resolves", async () => {
    const { queue } = pausable();
    queue.pause("user");
    expect(queue.held).toBeNull();
    await queue.idle();
  });
});
