import { expect, test } from "bun:test";
import { type NormalizedSpeakEvent, parseSpeakEvent } from "@mouthpiece/core";
import { Inbox, type InboxChange } from "./inbox.ts";

const route = { via: "orca", target: "term_abc", agent: "claude" } as const;

function event(fields: Record<string, unknown>): NormalizedSpeakEvent {
  const r = parseSpeakEvent({
    source: "agent",
    conversationId: "c1",
    text: "The tests pass.",
    ...fields,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function setup(history = { maxItems: 100, maxAgeMs: 60_000 }) {
  let t = 1_000;
  let n = 0;
  const inbox = new Inbox({ history, now: () => t, newId: () => `e${++n}` });
  const changes: InboxChange[] = [];
  inbox.subscribe((c) => changes.push(c));
  return {
    inbox,
    changes,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("a response creates a waiting entry with its route", () => {
  const { inbox, changes } = setup();
  const id = inbox.record(event({ label: "web", reply: route }));
  expect(id).toBe("e1");
  expect(inbox.list()).toEqual([
    {
      id: "e1",
      source: "agent",
      conversationId: "c1",
      label: "web",
      text: "The tests pass.",
      at: 1_000,
      route,
      state: "waiting",
      speech: "pending",
    },
  ]);
  expect(changes).toHaveLength(1);
});

test("a muted response's entry is flagged on its first emit", () => {
  const { inbox, changes } = setup();
  const id = inbox.record(event({ reply: route }), { muted: true });
  expect(inbox.get(id as string)?.muted).toBe(true);
  expect(changes).toEqual([
    { type: "entry", entry: expect.objectContaining({ id: "e1", muted: true }) },
  ]);
});

test("a later response replaces the entry with a new id and clears the summary", () => {
  const { inbox, advance } = setup();
  const first = inbox.record(event({})) as string;
  inbox.summarized(first, "Tests pass.");
  advance(10);
  const second = inbox.record(event({ text: "Now the build is green." }));
  const [entry] = inbox.list();
  expect(inbox.list()).toHaveLength(1);
  expect(entry?.id).toBe(second as string);
  expect(entry?.summary).toBeUndefined();
  expect(inbox.get(first)).toBeUndefined();
  expect(inbox.replaced(first)).toBe(true);
  expect(inbox.replaced("never-existed")).toBe(false);
});

test("a summary for a replaced entry is ignored", () => {
  const { inbox } = setup();
  const first = inbox.record(event({})) as string;
  inbox.record(event({ text: "Second." }));
  inbox.summarized(first, "Stale.");
  expect(inbox.list()[0]?.summary).toBeUndefined();
});

test("an alert is attached but never changes the state", () => {
  const { inbox } = setup();
  const id = inbox.record(event({})) as string;
  inbox.record(event({ kind: "alert", text: "web is waiting for you.", reply: route }));
  expect(inbox.get(id)).toMatchObject({
    state: "waiting",
    alert: { text: "web is waiting for you.", at: 1_000 },
    route,
  });
});

test("an alert with no entry yet, and info events, are not recorded", () => {
  const { inbox } = setup();
  expect(inbox.record(event({ kind: "alert" }))).toBeUndefined();
  expect(inbox.record(event({ kind: "info" }))).toBeUndefined();
  expect(inbox.list()).toEqual([]);
});

test("an interrupt makes that conversation busy; without an id, the whole source", () => {
  const { inbox } = setup();
  const a = inbox.record(event({ conversationId: "a" })) as string;
  const b = inbox.record(event({ conversationId: "b" })) as string;
  const other = inbox.record(event({ source: "other", conversationId: "a" })) as string;
  inbox.interrupted("agent", "a");
  expect([inbox.get(a)?.state, inbox.get(b)?.state]).toEqual(["busy", "waiting"]);
  inbox.interrupted("agent");
  expect([inbox.get(b)?.state, inbox.get(other)?.state]).toEqual(["busy", "waiting"]);
});

test("setState applies only to the current id and keeps the reply text private", () => {
  const { inbox } = setup();
  const id = inbox.record(event({})) as string;
  inbox.setState(id, "typed", { text: "go ahead", at: 1_500 });
  expect(inbox.get(id)).toMatchObject({
    state: "typed",
    replyText: "go ahead",
    reply: { at: 1_500 },
  });
  expect(JSON.stringify(inbox.list())).not.toContain("go ahead");
  inbox.setState("not-current", "busy");
  expect(inbox.get(id)?.state).toBe("typed");
});

test("entries past history limits are removed, with a remove change", () => {
  const { inbox, changes, advance } = setup({ maxItems: 2, maxAgeMs: 1_000 });
  const a = inbox.record(event({ conversationId: "a" })) as string;
  inbox.record(event({ conversationId: "b" }));
  inbox.record(event({ conversationId: "c" }));
  expect(inbox.get(a)).toBeUndefined();
  expect(changes).toContainEqual({ type: "remove", id: a });
  advance(1_001);
  expect(inbox.list()).toEqual([]);
});

test("list is newest first, and unsubscribe stops changes", () => {
  const { inbox, advance } = setup();
  const seen: InboxChange[] = [];
  const off = inbox.subscribe((c) => seen.push(c));
  inbox.record(event({ conversationId: "a" }));
  advance(5);
  inbox.record(event({ conversationId: "b" }));
  expect(inbox.list().map((e) => e.conversationId)).toEqual(["b", "a"]);
  off();
  inbox.record(event({ conversationId: "c" }));
  expect(seen).toHaveLength(2);
});

test("a terminal belongs to the latest conversation that reported from it", () => {
  const { inbox } = setup();
  const old = inbox.record(event({ conversationId: "before-clear", reply: route })) as string;
  const now = inbox.record(event({ conversationId: "after-clear", reply: route })) as string;
  expect(inbox.get(old)?.route).toBeUndefined();
  expect(inbox.get(now)?.route).toEqual(route);
});

test("a response without a route does not inherit the previous one", () => {
  const { inbox } = setup();
  inbox.record(event({ reply: route }));
  const id = inbox.record(event({ text: "Answered from elsewhere." })) as string;
  expect(inbox.get(id)?.route).toBeUndefined();
});

test("dismiss removes an entry with a remove change; the session's next response brings it back", () => {
  const { inbox, changes } = setup();
  const id = inbox.record(event({})) as string;
  expect(inbox.dismiss(id)).toBe("dismissed");
  expect(inbox.list()).toEqual([]);
  expect(changes.at(-1)).toEqual({ type: "remove", id });
  expect(inbox.dismiss(id)).toBe("gone");
  const again = inbox.record(event({ text: "One more question?" })) as string;
  expect(inbox.get(again)?.state).toBe("waiting");
});

test("dismiss refuses an entry with a reply in flight, and dismissAll skips it", () => {
  const { inbox } = setup();
  const sending = inbox.record(event({ conversationId: "a" })) as string;
  inbox.record(event({ conversationId: "b" }));
  inbox.record(event({ conversationId: "c" }));
  inbox.setState(sending, "sending");
  expect(inbox.dismiss(sending)).toBe("in-flight");
  expect(inbox.dismissAll()).toBe(2);
  expect(inbox.list().map((e) => e.id)).toEqual([sending]);
});

test("speech moves from pending to started or none once, with a change each time", () => {
  const { inbox, changes } = setup();
  const spoken = inbox.record(event({ conversationId: "a" })) as string;
  const silent = inbox.record(event({ conversationId: "b" })) as string;
  changes.length = 0;
  inbox.speech(spoken, "started");
  inbox.speech(spoken, "started");
  inbox.speech(spoken, "none");
  inbox.speech(silent, "none");
  inbox.speech(silent, "started");
  expect(inbox.get(spoken)?.speech).toBe("started");
  expect(inbox.get(silent)?.speech).toBe("none");
  expect(changes).toHaveLength(2);
});

test("speech for a replaced entry is ignored", () => {
  const { inbox } = setup();
  const first = inbox.record(event({})) as string;
  inbox.record(event({ text: "Second." }));
  inbox.speech(first, "started");
  expect(inbox.list()[0]?.speech).toBe("pending");
});
