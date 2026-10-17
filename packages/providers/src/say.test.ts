// packages/providers/src/say.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChunks } from "@mouthpiece/core";
import { SayProvider } from "./say.ts";

const onMac = process.platform === "darwin";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-say-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

test("rejects when aborted", async () => {
  const provider = new SayProvider({ tmpDir: dir, command: "sleep" });
  const controller = new AbortController();
  const p = provider.synthesize("5", { signal: controller.signal });
  controller.abort();
  await expect(p).rejects.toBeDefined();
});
