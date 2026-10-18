import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarginFollower, marginStateDir } from "./margin-follower.ts";
import type { TailMessage } from "./tailer.ts";

let dir: string;
let state: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-margin-"));
  state = join(dir, "state");
  await mkdir(state);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const reply = (seq: number, text: string, by = "agent", id = "c1") =>
  `${JSON.stringify({ seq, at: "2026-10-18T12:00:00.000Z", type: "reply", by, id, text })}\n`;

/** A doc with a log holding `lines`, and its paths. */
async function doc(name: string, lines = "") {
  const folder = join(dir, "docs");
  await mkdir(join(folder, ".margin"), { recursive: true });
  const path = join(folder, name);
  await writeFile(path, "# doc\n");
  const log = join(folder, ".margin", `${name}.jsonl`);
  if (lines) await writeFile(log, lines);
  return { path, log };
}

const recent = (paths: unknown) =>
  writeFile(join(state, "recent-docs.json"), JSON.stringify(paths));

function follower(opts: { doc?: string; rescanMs?: number } = {}) {
  const spoken: TailMessage[] = [];
  const followed: string[] = [];
  const errors: unknown[] = [];
  const t = { now: 0 };
  const f = new MarginFollower({
    ...opts,
    env: { MARGIN_STATE_DIR: state },
    onMessage: (m) => spoken.push(m),
    onFollow: (log) => followed.push(log),
    onError: (e) => errors.push(e),
    rescanMs: opts.rescanMs ?? 0,
    now: () => t.now,
  });
  return { f, spoken, followed, errors, t };
}

test("follows every recent doc from its end, then speaks new agent replies", async () => {
  const prd = await doc("PRD.md", reply(1, "history is not spoken"));
  await recent([prd.path]);
  const h = follower();
  await h.f.poll();
  expect(h.followed).toEqual([prd.log]);
  await appendFile(prd.log, reply(2, "please fix", "user") + reply(3, "Fixed in the summary."));
  await h.f.poll();
  expect(h.spoken).toEqual([
    { text: "Fixed in the summary.", conversationId: `${prd.path}#c1`, label: "PRD" },
  ]);
});

test("a doc that joins the list later is followed; a log created later is read from its start", async () => {
  await recent([]);
  const h = follower();
  await h.f.poll();
  const notes = await doc("notes.md");
  await recent([notes.path]);
  await h.f.poll();
  await writeFile(notes.log, reply(1, "First reply."));
  await h.f.poll();
  expect(h.spoken.map((m) => m.text)).toEqual(["First reply."]);
});

test("the list is re-read only every rescanMs", async () => {
  await recent([]);
  const h = follower({ rescanMs: 5000 });
  await h.f.poll();
  const notes = await doc("notes.md", reply(1, "old"));
  await recent([notes.path]);
  h.t.now = 4000;
  await h.f.poll();
  expect(h.followed).toEqual([]);
  h.t.now = 5000;
  await h.f.poll();
  expect(h.followed).toEqual([notes.log]);
});

test("with a doc, follows just that doc and never reads the list", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  await writeFile(join(state, "recent-docs.json"), "not json");
  const h = follower({ doc: prd.path });
  await h.f.poll();
  await appendFile(prd.log, reply(2, "New."));
  await h.f.poll();
  expect(h.followed).toEqual([prd.log]);
  expect(h.spoken.map((m) => m.text)).toEqual(["New."]);
  expect(h.errors).toEqual([]);
});

test("a missing, garbled or odd list follows nothing new and keeps what it has", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  await recent([prd.path, 7, "relative/doc.md", null]);
  const h = follower();
  await h.f.poll();
  expect(h.followed).toEqual([prd.log]);
  await writeFile(join(state, "recent-docs.json"), '["/half-writ'); // caught mid-write
  await h.f.poll();
  await rm(join(state, "recent-docs.json"));
  await h.f.poll();
  await appendFile(prd.log, reply(2, "Still heard."));
  await h.f.poll();
  expect(h.spoken.map((m) => m.text)).toEqual(["Still heard."]);
});

test("a torn line cut off by Margin is not followed by repeats", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  await recent([prd.path]);
  const h = follower();
  await h.f.poll();
  await appendFile(prd.log, reply(2, "Second."));
  await h.f.poll();
  const before = (await Bun.file(prd.log).text()).length;
  await appendFile(prd.log, '{"seq":3,"type":"rep'); // a crash mid-write
  await h.f.poll();
  await truncate(prd.log, before); // Margin's repair on the next open
  await h.f.poll();
  await appendFile(prd.log, reply(3, "Third."));
  await h.f.poll();
  expect(h.spoken.map((m) => m.text)).toEqual(["Second.", "Third."]);
});

test("marginStateDir follows Margin's own order", () => {
  expect(marginStateDir({ MARGIN_STATE_DIR: "/s", XDG_RUNTIME_DIR: "/x", HOME: "/h" })).toBe("/s");
  expect(marginStateDir({ XDG_RUNTIME_DIR: "/x", HOME: "/h" })).toBe("/x/margin");
  expect(marginStateDir({ HOME: "/h" })).toBe("/h/.cache/margin");
});
