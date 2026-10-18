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

test.skipIf(!onMac)("renders 16-bit WAV without playing and cleans temp files", async () => {
  const clip = await new SayProvider({ tmpDir: dir }).synthesize("Hello from Mouthpiece.");
  expect(clip.format).toBe("wav");
  const bytes = await collectChunks(clip.chunks);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
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

/** Stand-in for `say` that logs its arguments, fails when given `-v`, and otherwise writes "FORMfake". */
async function voicelessCommand(): Promise<{ command: string; calls: () => Promise<string[]> }> {
  const command = join(scriptDir, "voiceless-say");
  const log = join(scriptDir, "calls.log");
  await Bun.write(
    command,
    `#!/bin/sh
echo "$*" >> "${log}"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -v) echo "Voice $2 not found." >&2; exit 1 ;;
    -o) out="$2"; shift ;;
  esac
  shift
done
printf FORMfake > "$out"
`,
  );
  await chmod(command, 0o755);
  const calls = async () => (await Bun.file(log).text()).trim().split("\n");
  return { command, calls };
}

test("a voice say does not know is retried once in the system voice, with a warning", async () => {
  const { command, calls } = await voicelessCommand();
  const logs: Record<string, unknown>[] = [];
  const provider = new SayProvider({ tmpDir: dir, command, log: (r) => logs.push(r) });
  const clip = await provider.synthesize("x", { voice: "JBFqnCBsd6RMkjVDRZzb" });
  expect(new TextDecoder().decode(await collectChunks(clip.chunks))).toBe("FORMfake");
  const made = await calls();
  expect(made).toHaveLength(2);
  // Compare whole argument lists, not substrings: the temp dir is mkdtemp's `mp-say-XXXXXX`, and
  // a random suffix starting with "v" (about 1 run in 64) puts "-v" inside every path.
  const [first, retry] = made.map((line) => line.split(" "));
  expect(first).toEqual([
    "-f",
    expect.stringMatching(/\.txt$/),
    "-o",
    expect.stringMatching(/\.wav$/),
    "--file-format=WAVE",
    "--data-format=LEI16@24000",
    "-v",
    "JBFqnCBsd6RMkjVDRZzb",
  ]);
  // The retry renders the same text to the same file, in the system voice.
  expect(retry).toEqual(first?.slice(0, 6));
  expect(logs).toEqual([
    expect.objectContaining({
      level: "warn",
      msg: "say_voice_failed",
      voice: "JBFqnCBsd6RMkjVDRZzb",
    }),
  ]);
  expect(await readdir(dir)).toEqual([]);
});

test("the configured default voice is retried the same way", async () => {
  const { command, calls } = await voicelessCommand();
  const clip = await new SayProvider({ tmpDir: dir, command, voice: "Nobody" }).synthesize("x");
  expect((await collectChunks(clip.chunks)).length).toBe(8);
  expect(await calls()).toHaveLength(2);
});

test("without a voice there is no retry", async () => {
  const { command, calls } = await voicelessCommand();
  await new SayProvider({ tmpDir: dir, command }).synthesize("x");
  expect(await calls()).toHaveLength(1);
});

test("a failure in the system voice still rejects after the retry", async () => {
  const logs: Record<string, unknown>[] = [];
  const provider = new SayProvider({ tmpDir: dir, command: "false", log: (r) => logs.push(r) });
  await expect(provider.synthesize("x", { voice: "Ava" })).rejects.toThrow("say exited");
  expect(logs).toHaveLength(1);
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
