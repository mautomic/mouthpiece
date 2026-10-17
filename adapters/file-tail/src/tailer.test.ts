import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARSERS } from "./parsers.ts";
import {
  FileTailer,
  type FileTailerOptions,
  FULL_SCAN_EVERY,
  nodeTailFs,
  type TailFs,
  type TailMessage,
} from "./tailer.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-tail-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Tests run "on" 2026-10-17 (local), so date directories below are recent whatever today is. */
const TODAY = new Date(2026, 9, 17, 12).getTime();

function tailer(
  path: string,
  opts: Partial<
    Pick<FileTailerOptions, "pattern" | "parser" | "now" | "fs" | "idleMs" | "rescanMs">
  > = {},
) {
  const messages: TailMessage[] = [];
  const followed: string[] = [];
  const t = new FileTailer({
    parser: PARSERS.lines,
    now: () => TODAY,
    rescanMs: 0,
    ...opts,
    path,
    onMessage: (m) => messages.push(m),
    onFollow: (f) => followed.push(f),
  });
  const texts = () => messages.map((m) => m.text);
  return { t, messages, texts, followed };
}

test("starts at the end: pre-existing content is not emitted", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "old one\nold two\n");
  const { t, texts } = tailer(file);
  await t.poll();
  await t.poll();
  expect(texts()).toEqual([]);
});

test("appended lines are emitted in order, and polling again emits nothing", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "old\n");
  const { t, texts } = tailer(file);
  await t.poll();
  await appendFile(file, "first\nsecond\n");
  await t.poll();
  await appendFile(file, "third\n");
  await t.poll();
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["first", "second", "third"]);
});

test("a line written in two halves across polls is emitted once", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "");
  const { t, texts } = tailer(file);
  await t.poll();
  await appendFile(file, "hel");
  await t.poll();
  expect(texts()).toEqual([]);
  await appendFile(file, "lo\n");
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["hello"]);
});

test("a multi-byte character split across reads survives", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "");
  const { t, texts } = tailer(file);
  await t.poll();
  const bytes = new TextEncoder().encode("héllo wörld\n");
  await appendFile(file, bytes.slice(0, 2));
  await t.poll();
  await appendFile(file, bytes.slice(2));
  await t.poll();
  expect(texts()).toEqual(["héllo wörld"]);
});

test("an unterminated last line at start is not spoken as a fragment", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "complete\nhalf a li");
  const { t, texts } = tailer(file);
  await t.poll();
  await appendFile(file, "ne\nnext\n");
  await t.poll();
  expect(texts()).toEqual(["next"]);
});

test("truncation restarts from 0 without re-emitting old content", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "aaaa\nbbbb\n");
  const { t, texts } = tailer(file);
  await t.poll();
  await appendFile(file, "spoken once\n");
  await t.poll();
  await truncate(file, 0);
  await appendFile(file, "new\n");
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["spoken once", "new"]);
});

test("a rewrite longer than the old offset is detected too", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "a\n");
  const { t, texts } = tailer(file);
  await t.poll();
  await appendFile(file, "b\n");
  await t.poll();
  await writeFile(file, "a much longer replacement line\nand another\n");
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["b", "a much longer replacement line", "and another"]);
});

test("a file that appears after start is read from its beginning", async () => {
  const file = join(dir, "later.txt");
  const { t, texts } = tailer(file);
  await t.poll();
  await writeFile(file, "hello\n");
  await t.poll();
  expect(texts()).toEqual(["hello"]);
});

test("a parser that throws does not stop the tailer", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "");
  const { t, texts } = tailer(file, {
    parser: (line) => {
      if (line === "bad") throw new Error("boom");
      return { text: line };
    },
  });
  await t.poll();
  await appendFile(file, "bad\ngood\n");
  await t.poll();
  expect(texts()).toEqual(["good"]);
});

const ROLLOUT = /^rollout-.*\.jsonl$/;
const ago = (s: number) => new Date(Date.now() - s * 1000);

test("directory mode follows the newest matching file, nested by date", async () => {
  const sessions = join(dir, "sessions");
  const oldDir = join(sessions, "2026", "10", "16");
  const newDir = join(sessions, "2026", "10", "17");
  await mkdir(oldDir, { recursive: true });
  const oldFile = join(oldDir, "rollout-old.jsonl");
  const olderFile = join(oldDir, "rollout-older.jsonl");
  await writeFile(olderFile, "older history\n");
  await utimes(olderFile, ago(300), ago(300));
  await writeFile(oldFile, "old history\n");
  await utimes(oldFile, ago(200), ago(200));

  const { t, texts, followed } = tailer(sessions, { pattern: ROLLOUT });
  await t.poll();
  expect(followed).toEqual([oldFile]);
  await t.poll();
  expect(texts()).toEqual([]);

  await appendFile(oldFile, "old one\n");
  await t.poll();
  expect(texts()).toEqual(["old one"]);

  // The old file's final message and a newer session appear between two polls: neither is lost.
  await appendFile(oldFile, "old final\n");
  await utimes(oldFile, ago(100), ago(100));
  await mkdir(newDir, { recursive: true });
  const newFile = join(newDir, "rollout-new.jsonl");
  await writeFile(newFile, "new one\n");
  await utimes(newFile, ago(50), ago(50));
  await writeFile(join(newDir, "notes.txt"), "not a session\n");
  await t.poll();
  expect(followed).toEqual([oldFile, newFile]);
  expect(texts()).toEqual(["old one", "old final", "new one"]);

  // Both stay followed: later appends to either file are emitted, once each.
  await appendFile(oldFile, "old later\n");
  await t.poll();
  await appendFile(newFile, "new two\n");
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["old one", "old final", "new one", "old later", "new two"]);
  expect(followed).toEqual([oldFile, newFile]);
  expect(t.following).toBe(newFile);
});

test("directory mode follows concurrent sessions: nothing from either file is lost", async () => {
  const sessions = join(dir, "sessions");
  const day = join(sessions, "2026", "10", "17");
  await mkdir(day, { recursive: true });
  const a = join(day, "rollout-a.jsonl");
  await writeFile(a, "a history\n");
  const { t, messages, followed } = tailer(sessions, {
    pattern: ROLLOUT,
    parser: (line, file) => ({ text: line, label: file === a ? "A" : "B" }),
  });
  await t.poll();
  await appendFile(a, "a1\n");
  await t.poll();
  expect(followed).toEqual([a]);

  const b = join(day, "rollout-b.jsonl");
  await writeFile(b, "b1\n");
  await t.poll();
  expect(followed).toEqual([a, b]);
  await appendFile(a, "a final\n");
  await t.poll();
  await appendFile(b, "b2\nb3\n");
  await t.poll();
  await appendFile(a, "a after b\n");
  await appendFile(b, "b4\n");
  await t.poll();
  await t.poll();

  const from = (label: string) => messages.filter((m) => m.label === label).map((m) => m.text);
  expect(from("A")).toEqual(["a1", "a final", "a after b"]);
  expect(from("B")).toEqual(["b1", "b2", "b3", "b4"]);
  expect(messages).toHaveLength(7);
  expect(followed).toEqual([a, b]);
});

test("a pre-existing session that is resumed later is read from where it was at start", async () => {
  const sessions = join(dir, "sessions");
  const day = join(sessions, "2026", "10", "17");
  await mkdir(day, { recursive: true });
  const older = join(day, "rollout-older.jsonl");
  const newer = join(day, "rollout-newer.jsonl");
  await writeFile(older, "older history\n");
  await utimes(older, ago(300), ago(300));
  await writeFile(newer, "newer history\n");
  const { t, texts, followed } = tailer(sessions, { pattern: ROLLOUT });
  await t.poll();
  expect(followed).toEqual([newer]);
  await appendFile(older, "resumed\n");
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["resumed"]);
  expect(followed).toEqual([newer, older]);
  expect(t.following).toBe(older);
});

test("a session idle past idleMs is retired, and picked up again where it stopped", async () => {
  const sessions = join(dir, "sessions");
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, "rollout-x.jsonl");
  await writeFile(file, "");
  const clock = { t: 1_000_000 };
  const { t, texts, followed } = tailer(sessions, {
    pattern: ROLLOUT,
    now: () => clock.t,
    idleMs: 60_000,
  });
  await t.poll();
  await appendFile(file, "one\nhal");
  clock.t += 10_000;
  await t.poll();
  clock.t += 61_000;
  await t.poll();
  expect(t.following).toBeNull();
  await appendFile(file, "f\ntwo\n");
  clock.t += 10_000;
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["one", "half", "two"]);
  expect(followed).toEqual([file, file]);
  expect(t.following).toBe(file);
});

test("directory mode with no session yet follows the first one from its beginning", async () => {
  const sessions = join(dir, "tmp");
  await mkdir(sessions);
  const { t, messages, followed } = tailer(sessions, {
    pattern: /^session-.*\.jsonl$/,
    parser: PARSERS.gemini,
  });
  await t.poll();
  expect(followed).toEqual([]);
  const chats = join(sessions, "3f2a9c", "chats");
  await mkdir(chats, { recursive: true });
  const file = join(chats, "session-2026-10-17T12-00-a1b2c3d4.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ sessionId: "a1b2c3d4", projectHash: "3f2a9c" }),
      JSON.stringify({ id: "m1", type: "user", content: "hi" }),
      JSON.stringify({ id: "m2", type: "gemini", content: "Hello!" }),
      JSON.stringify({ $patch: { id: "m2", content: "Hello again!" } }),
      "",
    ].join("\n"),
  );
  await t.poll();
  expect(followed).toEqual([file]);
  expect(messages).toEqual([{ text: "Hello!", conversationId: "a1b2c3d4" }]);
});

test("files are searched 4 directory levels deep (like sessions/YYYY/MM/DD), no deeper", async () => {
  const sessions = join(dir, "sessions");
  const deep = join(sessions, "a", "b", "c", "d");
  await mkdir(deep, { recursive: true });
  const { t, followed } = tailer(sessions, { pattern: ROLLOUT });
  await t.poll();
  await writeFile(join(deep, "rollout-deep.jsonl"), "x\n");
  await utimes(join(deep, "rollout-deep.jsonl"), new Date(), new Date(Date.now() + 60_000));
  await writeFile(join(sessions, "a", "b", "c", "rollout-ok.jsonl"), "y\n");
  await t.poll();
  expect(followed).toEqual([join(sessions, "a", "b", "c", "rollout-ok.jsonl")]);
});

test("start() polls on an interval and stop() ends it", async () => {
  const file = join(dir, "log.txt");
  await writeFile(file, "");
  const messages: TailMessage[] = [];
  const t = new FileTailer({
    path: file,
    parser: PARSERS.lines,
    onMessage: (m) => messages.push(m),
    pollMs: 5,
  });
  t.start();
  await t.poll();
  await appendFile(file, "via interval\n");
  for (let i = 0; i < 400 && messages.length === 0; i++) await Bun.sleep(5);
  t.stop();
  expect(messages.map((m) => m.text)).toEqual(["via interval"]);
  await appendFile(file, "after stop\n");
  await Bun.sleep(30);
  expect(messages.map((m) => m.text)).toEqual(["via interval"]);
});

/** The real file system, recording every directory listed. */
function countingFs(): TailFs & { listed: string[] } {
  const listed: string[] = [];
  return {
    ...nodeTailFs,
    listed,
    listDir: (path) => {
      listed.push(path);
      return nodeTailFs.listDir(path);
    },
  };
}

test("polls drain followed files every time but rescan the tree at most every rescanMs", async () => {
  const sessions = join(dir, "sessions");
  const day = join(sessions, "2026", "10", "17");
  await mkdir(day, { recursive: true });
  const file = join(day, "rollout-a.jsonl");
  await writeFile(file, "");
  const fs = countingFs();
  const clock = { t: TODAY };
  const { t, texts, followed } = tailer(sessions, {
    pattern: ROLLOUT,
    fs,
    now: () => clock.t,
    rescanMs: 5000,
  });
  await t.poll();
  const oneScan = fs.listed.length;
  expect(oneScan).toBe(4); // sessions, 2026, 10, 17
  const later = join(day, "rollout-b.jsonl");
  await writeFile(later, "b1\n");
  for (let i = 0; i < 9; i++) {
    clock.t += 500;
    await appendFile(file, `a${i}\n`);
    await t.poll();
  }
  expect(fs.listed).toHaveLength(oneScan);
  expect(texts()).toEqual(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
  expect(followed).toEqual([file]);

  clock.t += 500;
  await t.poll();
  expect(fs.listed).toHaveLength(2 * oneScan);
  expect(followed).toEqual([file, later]);
  expect(texts().at(-1)).toBe("b1");
});

test("rescans skip date directories older than yesterday", async () => {
  const sessions = join(dir, "sessions");
  const old = join(sessions, "2026", "09", "30");
  const yesterday = join(sessions, "2026", "10", "16");
  const lastYear = join(sessions, "2025", "12", "31");
  for (const d of [old, yesterday, lastYear]) await mkdir(d, { recursive: true });
  await writeFile(join(old, "rollout-old.jsonl"), "");
  const fs = countingFs();
  const { t, texts } = tailer(sessions, { pattern: ROLLOUT, fs });
  await t.poll();
  fs.listed.length = 0;
  await writeFile(join(yesterday, "rollout-y.jsonl"), "from yesterday\n");
  await mkdir(join(sessions, "2026", "10", "17"));
  await writeFile(join(sessions, "2026", "10", "17", "rollout-t.jsonl"), "from today\n");
  await t.poll();
  expect(texts().sort()).toEqual(["from today", "from yesterday"]);
  expect(fs.listed).not.toContain(old);
  expect(fs.listed).not.toContain(join(sessions, "2025"));
  expect(fs.listed).toContain(yesterday);
});

test("a resumed session in an old date directory is found by the periodic full scan", async () => {
  const sessions = join(dir, "sessions");
  const old = join(sessions, "2026", "09", "30");
  await mkdir(old, { recursive: true });
  const resumed = join(old, "rollout-old.jsonl");
  await writeFile(resumed, "history\n");
  await utimes(resumed, ago(300), ago(300));
  const today = join(sessions, "2026", "10", "17");
  await mkdir(today, { recursive: true });
  await writeFile(join(today, "rollout-today.jsonl"), "newest at start\n");
  const fs = countingFs();
  const { t, texts } = tailer(sessions, { pattern: ROLLOUT, fs });
  await t.poll(); // the first scan is full: it notes where the old session ends
  await appendFile(resumed, "resumed\n");
  for (let i = 1; i < FULL_SCAN_EVERY; i++) await t.poll();
  expect(texts()).toEqual([]);
  expect(fs.listed.filter((d) => d === old)).toHaveLength(1);
  await t.poll();
  expect(texts()).toEqual(["resumed"]);
  await appendFile(resumed, "and followed from then on\n");
  await t.poll();
  expect(texts()).toEqual(["resumed", "and followed from then on"]);
});

test("a line written while a session is being retired is still read", async () => {
  const sessions = join(dir, "sessions");
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, "rollout-x.jsonl");
  await writeFile(file, "");
  // Once armed, the second stat of the file (the retire check, after drain's) appends a line first.
  const hook = { armed: false, stats: 0 };
  const fs: TailFs = {
    ...nodeTailFs,
    stat: async (path) => {
      if (hook.armed && path === file && ++hook.stats === 2) {
        hook.armed = false;
        await appendFile(file, "task complete\n");
      }
      return nodeTailFs.stat(path);
    },
  };
  const clock = { t: 1_000_000 };
  const { t, texts } = tailer(sessions, {
    pattern: ROLLOUT,
    fs,
    now: () => clock.t,
    idleMs: 60_000,
  });
  await t.poll();
  await appendFile(file, "one\n");
  clock.t += 10_000;
  await t.poll();
  clock.t += 61_000;
  hook.armed = true;
  await t.poll();
  expect(hook.stats).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < 3; i++) {
    clock.t += 1000;
    await t.poll();
  }
  expect(texts()).toEqual(["one", "task complete"]);
});

test("the date cutoff moves with the clock, so a long-running rescan stays small", async () => {
  const sessions = join(dir, "sessions");
  const start = new Date(2026, 9, 1, 12).getTime();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < 30; i++) {
    const d = new Date(2026, 9, 1 + i);
    const day = join(sessions, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    await mkdir(day, { recursive: true });
    await writeFile(join(day, `rollout-${i}.jsonl`), "");
  }
  const later = start + 29 * 24 * 60 * 60_000;

  // A tailer started 29 days ago, rescanning now.
  const longFs = countingFs();
  const clock = { t: start };
  const long = tailer(sessions, { pattern: ROLLOUT, fs: longFs, now: () => clock.t });
  await long.t.poll();
  clock.t = later;
  longFs.listed.length = 0;
  await long.t.poll(); // a rescan, not a full one

  // A tailer started now, on its first rescan.
  const freshFs = countingFs();
  const fresh = tailer(sessions, { pattern: ROLLOUT, fs: freshFs, now: () => later });
  await fresh.t.poll();
  freshFs.listed.length = 0;
  await fresh.t.poll();

  expect(freshFs.listed).toHaveLength(5); // sessions, 2026, 10, 29, 30
  expect(longFs.listed.sort()).toEqual(freshFs.listed.sort());
});
