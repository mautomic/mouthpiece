// packages/providers/src/say.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChunks } from "@mouthpiece/core";
import { parseSayVoices, SayProvider } from "./say.ts";

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

const VOICE_FIXTURE = [
  "Alex                en_US    # Most people recognize me by my voice.",
  "Ava (Premium)       en_US    # Hello, my name is Ava.",
  "Amélie              fr_CA    # Bonjour, je m’appelle Amélie.",
  // Long names leave a single space before the locale (real macOS output).
  "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
  "this line is not a voice",
  "",
].join("\n");

test("parseSayVoices parses names and locales and skips malformed lines", () => {
  expect(parseSayVoices(VOICE_FIXTURE)).toEqual([
    { id: "Alex", name: "Alex", language: "en-US" },
    { id: "Ava (Premium)", name: "Ava (Premium)", language: "en-US" },
    { id: "Amélie", name: "Amélie", language: "fr-CA" },
    { id: "Eddy (English (UK))", name: "Eddy (English (UK))", language: "en-GB" },
  ]);
});

test("listVoices runs `say -v ?` through the injected command", async () => {
  const fixture = join(scriptDir, "voices.txt");
  const argsFile = join(scriptDir, "args.txt");
  await Bun.write(fixture, VOICE_FIXTURE);
  const path = join(scriptDir, "list-say");
  await Bun.write(path, `#!/bin/sh\necho "$@" > '${argsFile}'\ncat '${fixture}'\n`);
  await chmod(path, 0o755);
  const voices = await new SayProvider({ tmpDir: dir, command: path }).listVoices();
  expect(voices.map((v) => v.id)).toEqual([
    "Alex",
    "Ava (Premium)",
    "Amélie",
    "Eddy (English (UK))",
  ]);
  expect((await Bun.file(argsFile).text()).trim()).toBe("-v ?");
});

test("listVoices rejects when the command fails", async () => {
  await expect(new SayProvider({ tmpDir: dir, command: "false" }).listVoices()).rejects.toThrow(
    "say exited",
  );
});
