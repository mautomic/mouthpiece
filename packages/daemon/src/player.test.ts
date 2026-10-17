// packages/daemon/src/player.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { singleChunk } from "@mouthpiece/core";
import { AfplayPlayer } from "./player.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-player-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const clip = () => ({ format: "mp3" as const, chunks: singleChunk(new Uint8Array([1, 2, 3])) });

test("writes the clip to a temp file, runs the command, removes the file", async () => {
  const player = new AfplayPlayer({
    tmpDir: dir,
    command: ["/bin/sh", "-c", 'test -s "$0" && case "$0" in *.mp3) exit 0;; *) exit 1;; esac'],
  });
  await player.play(clip(), new AbortController().signal);
  expect(await readdir(dir)).toEqual([]);
});

test("abort stops playback promptly", async () => {
  const player = new AfplayPlayer({ tmpDir: dir, command: ["/bin/sh", "-c", "sleep 5"] });
  const controller = new AbortController();
  const started = performance.now();
  const p = player.play(clip(), controller.signal);
  setTimeout(() => controller.abort(), 50);
  await p;
  expect(performance.now() - started).toBeLessThan(1000);
});

test("non-zero exit without abort rejects", async () => {
  const player = new AfplayPlayer({ tmpDir: dir, command: ["/bin/sh", "-c", "exit 3"] });
  await expect(player.play(clip(), new AbortController().signal)).rejects.toThrow("exited with 3");
});

test("a failing chunk stream rejects", async () => {
  async function* broken(): AsyncIterable<Uint8Array> {
    yield new Uint8Array([1]);
    throw new Error("stream broke");
  }
  const player = new AfplayPlayer({ tmpDir: dir, command: ["true"] });
  await expect(
    player.play({ format: "mp3", chunks: broken() }, new AbortController().signal),
  ).rejects.toThrow("stream broke");
});
