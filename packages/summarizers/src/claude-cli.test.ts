import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliSummarizer } from "./claude-cli.ts";
import { summaryPrompt } from "./prompt.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-sum-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakeClaude(body: string): Promise<string> {
  const path = join(dir, "claude");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const make = (
  command: string,
  extra: Partial<ConstructorParameters<typeof ClaudeCliSummarizer>[0]> = {},
) =>
  new ClaudeCliSummarizer({
    command,
    model: "haiku",
    timeoutMs: 2000,
    maxChars: 60,
    cwd: join(dir, "cwd"),
    env: { PATH: process.env.PATH ?? "" },
    ...extra,
  });

test("runs claude -p with the measured flags, child env, and wrapped stdin; trims output", async () => {
  const cmd = await fakeClaude(
    `D=$(dirname "$0"); printf '%s\\n' "$@" > "$D/args"; printf '%s' "$MOUTHPIECE_CHILD" > "$D/child"; pwd > "$D/cwd.txt"; cat > "$D/stdin"
echo "I need your call on interrupts. I fixed the race. Everything passes now."`,
  );
  const summary = await make(cmd).summarize("Full text here.", { source: "claude-code" });
  expect(summary).toBe("I need your call on interrupts. I fixed the race.");
  expect((await readFile(join(dir, "args"), "utf8")).split("\n")).toEqual([
    "-p",
    "--model",
    "haiku",
    "--tools",
    "",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--system-prompt",
    ...summaryPrompt(60, "Full text here.".length).split("\n"),
    "",
  ]);
  expect(await readFile(join(dir, "child"), "utf8")).toBe("1");
  expect(await readFile(join(dir, "stdin"), "utf8")).toBe(
    "<message>\nFull text here.\n</message>\n",
  );
  expect((await readFile(join(dir, "cwd.txt"), "utf8")).trim()).toEndWith("/cwd");
});

test("non-zero exit rejects with stderr", async () => {
  await expect(
    make(await fakeClaude('echo "not logged in" >&2; exit 1')).summarize("x", { source: "s" }),
  ).rejects.toThrow("not logged in");
});

test("empty output rejects", async () => {
  await expect(make(await fakeClaude("true")).summarize("x", { source: "s" })).rejects.toThrow(
    "empty summary",
  );
});

test("times out", async () => {
  const started = performance.now();
  await expect(
    make(await fakeClaude("sleep 5"), { timeoutMs: 100 }).summarize("x", { source: "s" }),
  ).rejects.toThrow("timed out");
  expect(performance.now() - started).toBeLessThan(1500);
});

test("missing command rejects", async () => {
  await expect(make(join(dir, "nope")).summarize("x", { source: "s" })).rejects.toBeDefined();
});

test("abort rejects", async () => {
  const c = new AbortController();
  const p = make(await fakeClaude("sleep 5")).summarize("x", { source: "s", signal: c.signal });
  c.abort();
  await expect(p).rejects.toBeDefined();
});
