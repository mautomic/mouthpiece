// packages/providers/src/say.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChunks } from "@mouthpiece/core";
import { SayProvider } from "./say.ts";

const onMac = process.platform === "darwin";
let dir: string;
let scriptDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-say-"));
  scriptDir = await mkdtemp(join(tmpdir(), "mp-say-bin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(scriptDir, { recursive: true, force: true });
});

test.skipIf(!onMac)("renders AIFF without playing and cleans temp files", async () => {
  const clip = await new SayProvider({ tmpDir: dir }).synthesize("Hello from Mouthpiece.");
  expect(clip.format).toBe("aiff");
  const bytes = await collectChunks(clip.chunks);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("FORM");
  expect(await readdir(dir)).toEqual([]);
});

test.skipIf(!onMac)("text starting with a dash is spoken, not parsed as a flag", async () => {
  const clip = await new SayProvider({ tmpDir: dir }).synthesize("-v is not an option");
  expect((await collectChunks(clip.chunks)).length).toBeGreaterThan(100);
});

test("rejects when the command fails", async () => {
  await expect(new SayProvider({ tmpDir: dir, command: "false" }).synthesize("x")).rejects.toThrow(
    "say exited",
  );
});

/** Stand-in for `say` that ignores its arguments and runs until killed. */
async function sleepingCommand(): Promise<string> {
  const path = join(scriptDir, "slow-say");
  await Bun.write(path, "#!/bin/sh\nexec sleep 5\n");
  await chmod(path, 0o755);
  return path;
}

test("an abort before the command is spawned rejects promptly", async () => {
  const provider = new SayProvider({ tmpDir: dir, command: await sleepingCommand() });
  const controller = new AbortController();
  const started = performance.now();
  const p = provider.synthesize("x", { signal: controller.signal });
  controller.abort(); // lands while the text file is being written, before spawn
  await expect(p).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(await readdir(dir)).toEqual([]);
});

test("an abort while the command runs kills it and rejects promptly", async () => {
  const provider = new SayProvider({ tmpDir: dir, command: await sleepingCommand() });
  const controller = new AbortController();
  const started = performance.now();
  const p = provider.synthesize("x", { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await expect(p).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(await readdir(dir)).toEqual([]);
});
