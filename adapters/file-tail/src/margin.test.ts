import { expect, test } from "bun:test";
import { createMarginParser, marginDoc, marginLog } from "./margin.ts";

const LOG = "/work/docs/.margin/PRD.md.jsonl";
const line = (e: Record<string, unknown>) =>
  JSON.stringify({ at: "2026-10-18T12:00:00.000Z", ...e });
const reply = (seq: number, by: string, text: string, id = "c1") =>
  line({ seq, type: "reply", by, id, text });

test("a doc's log sits in .margin beside it, and back", () => {
  expect(marginLog("/work/docs/PRD.md")).toBe(LOG);
  expect(marginDoc(LOG)).toBe("/work/docs/PRD.md");
});

test("an agent's reply is spoken, labeled with the doc's name, per thread", () => {
  const parse = createMarginParser();
  expect(parse(reply(8, "agent", "Agreed, **US-016** covers it."), LOG)).toEqual({
    text: "Agreed, **US-016** covers it.",
    conversationId: "/work/docs/PRD.md#c1",
    label: "PRD",
  });
});

test("an agent's suggestion speaks its note", () => {
  const parse = createMarginParser();
  const suggest = (seq: number, note?: string) =>
    line({ seq, type: "suggest", by: "agent", id: "c2", replace: "x", apply: false, note });
  expect(parse(suggest(1, "Make quota tracking a goal"), LOG)?.text).toBe(
    "Suggested edit: Make quota tracking a goal",
  );
  expect(parse(suggest(2), LOG)).toBeNull();
});

test.each([
  ["the user's reply", reply(1, "user", "please fix")],
  [
    "the user's comment",
    line({ seq: 1, type: "comment", by: "user", id: "c1", text: "hm", draft: false }),
  ],
  ["a whitespace-only agent reply", reply(1, "agent", "   ")],
  ["an accept", line({ seq: 1, type: "accept", by: "user", id: "c1" })],
  ["an edit", line({ seq: 1, type: "edit", by: "agent", at: 0, remove: 0, insert: "x" })],
  ["a reply without a thread id", line({ seq: 1, type: "reply", by: "agent", text: "x" })],
  ["a line without a seq", line({ type: "reply", by: "agent", id: "c1", text: "x" })],
  ["malformed JSON", '{"seq": 1, "type": "reply"'],
  ["not an object", "[1,2]"],
])("nothing is spoken for %s", (_, input) => {
  expect(createMarginParser()(input, LOG)).toBeNull();
});

test("an event at or below the last seq seen in that log is skipped (a re-read after truncation)", () => {
  const parse = createMarginParser();
  expect(parse(reply(5, "agent", "first"), LOG)).not.toBeNull();
  expect(parse(reply(3, "agent", "old"), LOG)).toBeNull();
  expect(parse(reply(5, "agent", "first"), LOG)).toBeNull();
  expect(parse(reply(6, "agent", "next"), LOG)?.text).toBe("next");
  // A user event still moves the mark, so re-reading it later can't let older replies through.
  expect(parse(reply(7, "user", "thanks"), LOG)).toBeNull();
  expect(parse(reply(6, "agent", "next"), LOG)).toBeNull();
  // Another log keeps its own mark.
  expect(parse(reply(1, "agent", "elsewhere"), "/other/.margin/A.md.jsonl")?.text).toBe(
    "elsewhere",
  );
});

test("docs with the same name in different folders are different conversations", () => {
  const parse = createMarginParser();
  const a = parse(reply(1, "agent", "x"), "/a/.margin/README.md.jsonl");
  const b = parse(reply(1, "agent", "x"), "/b/.margin/README.md.jsonl");
  expect(a?.label).toBe("README");
  expect(a?.conversationId).not.toBe(b?.conversationId);
});

test("a very long path keeps the end of the conversation id, within 256 chars", () => {
  const deep = `/${"d".repeat(300)}/.margin/notes.md.jsonl`;
  const id = createMarginParser()(reply(1, "agent", "x", "c9"), deep)?.conversationId ?? "";
  expect(id.length).toBe(256);
  expect(id.endsWith("notes.md#c9")).toBe(true);
});
