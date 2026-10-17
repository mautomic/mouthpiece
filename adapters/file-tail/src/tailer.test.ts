import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARSERS } from "./parsers.ts";
import { FileTailer, type LineParser, type TailMessage } from "./tailer.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-tail-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tailer(path: string, opts: { pattern?: RegExp; parser?: LineParser } = {}) {
  const messages: TailMessage[] = [];
  const followed: string[] = [];
  const t = new FileTailer({
    path,
    pattern: opts.pattern,
    parser: opts.parser ?? PARSERS.lines,
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

  // Later appends to the file we left are ignored, even though it is now the most recent.
  await appendFile(oldFile, "old later\n");
  await t.poll();
  await appendFile(newFile, "new two\n");
  await t.poll();
  await t.poll();
  expect(texts()).toEqual(["old one", "old final", "new one", "new two"]);
  expect(followed).toEqual([oldFile, newFile]);
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
