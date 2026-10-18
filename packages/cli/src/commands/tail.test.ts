import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakEvent } from "@mouthpiece/core";
import type { CliDeps, CliIO } from "../types.ts";
import { defaultTailPath, tailCommand } from "./tail.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-tail-cmd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(opts: { failFirst?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spoken: SpeakEvent[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "",
    stdinIsTTY: true,
  };
  const unused = async (): Promise<never> => {
    throw new Error("unexpected client call");
  };
  let calls = 0;
  const controller = new AbortController();
  const deps: CliDeps & { signal: AbortSignal; pollMs: number } = {
    client: {
      speak: async (e) => {
        calls++;
        if (opts.failFirst && calls === 1) throw new Error("mouthpiece daemon unreachable");
        spoken.push(e);
        return { id: `id${calls}` };
      },
      stop: unused,
      skip: unused,
      health: unused,
      getMode: unused,
      setMode: unused,
      replay: unused,
      usage: unused,
      voices: unused,
      status: unused,
      pause: unused,
      resume: unused,
      inbox: unused,
      reply: unused,
      submitReply: unused,
      dismissInbox: unused,
    },
    startDaemon: unused,
    env: { HOME: "/home/me" },
    exec: async () => {
      throw new Error("unexpected exec");
    },
    paths: { repoRoot: "/repo", bun: "/u/.bun/bin/bun" },
    signal: controller.signal,
    pollMs: 5,
  };
  return { io, deps, out, err, spoken, controller };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5);
}

test("tail --format lines speaks appended lines as cli responses until aborted", async () => {
  const file = join(dir, "build.log");
  await writeFile(file, "history is not spoken\n");
  const h = harness();
  const done = tailCommand(["--format", "lines", "--path", file], h.io, h.deps);
  await until(() => h.err.join("").includes("following"));
  await appendFile(file, "Build started.\nBuild **finished**.\n");
  await until(() => h.spoken.length >= 2);
  h.controller.abort();
  expect(await done).toBe(0);
  expect(h.spoken).toEqual([
    { text: "Build started.", source: "cli", kind: "response", format: "markdown" },
    { text: "Build **finished**.", source: "cli", kind: "response", format: "markdown" },
  ]);
  expect(h.err.join("")).toContain(`following ${file}`);
});

test("--source and --label are applied; speak errors are warnings and do not stop the tail", async () => {
  const file = join(dir, "x.log");
  await writeFile(file, "");
  const h = harness({ failFirst: true });
  const done = tailCommand(
    ["--format", "lines", "--path", file, "--source", "ci", "--label", "deploy"],
    h.io,
    h.deps,
  );
  await until(() => h.err.join("").includes("following"));
  await appendFile(file, "one\ntwo\n");
  await until(() => h.spoken.length >= 1);
  h.controller.abort();
  expect(await done).toBe(0);
  expect(h.spoken).toEqual([
    { text: "two", source: "ci", label: "deploy", kind: "response", format: "markdown" },
  ]);
  expect(h.err.join("")).toContain("warning: mouthpiece daemon unreachable");
});

test("codex format speaks task_complete messages with the session id", async () => {
  const sessions = join(dir, "sessions");
  const h = harness();
  const done = tailCommand(["--format", "codex", "--path", sessions], h.io, h.deps);
  await until(() => h.err.join("").includes("waiting"));
  expect(h.err.join("")).toContain(`waiting for ${sessions}`);
  const day = join(sessions, "2026", "10", "17");
  await mkdir(day, { recursive: true });
  const file = join(day, "rollout-2026-10-17T12-00-00-0199f0aa-1234-7abc-8def-0123456789ab.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Done." },
    })}\n`,
  );
  await until(() => h.spoken.length >= 1);
  h.controller.abort();
  expect(await done).toBe(0);
  expect(h.spoken).toEqual([
    {
      text: "Done.",
      source: "codex",
      conversationId: "0199f0aa-1234-7abc-8def-0123456789ab",
      kind: "response",
      format: "markdown",
    },
  ]);
});

test("--format nope exits 2", async () => {
  const h = harness();
  expect(await tailCommand(["--format", "nope"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("--format");
});

test("a missing --format exits 2, and lines requires --path", async () => {
  const h = harness();
  expect(await tailCommand([], h.io, h.deps)).toBe(2);
  expect(await tailCommand(["--format", "lines"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("--path");
});

test("default paths honor CODEX_HOME and GEMINI_HOME", () => {
  expect(defaultTailPath("codex", { HOME: "/h" })).toBe("/h/.codex/sessions");
  expect(defaultTailPath("codex", { HOME: "/h", CODEX_HOME: "/c" })).toBe("/c/sessions");
  expect(defaultTailPath("gemini", { HOME: "/h" })).toBe("/h/.gemini/tmp");
  expect(defaultTailPath("gemini", { HOME: "/h", GEMINI_HOME: "/g" })).toBe("/g/tmp");
  expect(defaultTailPath("lines", { HOME: "/h" })).toBeUndefined();
});

test("tail --format margin --path <doc> speaks the agent's replies as source margin", async () => {
  const docs = join(dir, "docs");
  await mkdir(join(docs, ".margin"), { recursive: true });
  const doc = join(docs, "PRD.md");
  const log = join(docs, ".margin", "PRD.md.jsonl");
  await writeFile(log, "");
  const h = harness();
  const done = tailCommand(["--format", "margin", "--path", doc], h.io, h.deps);
  await until(() => h.err.join("").includes("following"));
  await appendFile(
    log,
    `${JSON.stringify({ seq: 1, type: "reply", by: "agent", id: "c1", text: "Agreed." })}\n`,
  );
  await until(() => h.spoken.length >= 1);
  h.controller.abort();
  expect(await done).toBe(0);
  expect(h.spoken[0]).toMatchObject({
    text: "Agreed.",
    source: "margin",
    label: "PRD",
    announce: "always",
  });
});
