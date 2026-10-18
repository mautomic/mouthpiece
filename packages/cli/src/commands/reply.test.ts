import { expect, test } from "bun:test";
import { MouthpieceError } from "@mouthpiece/client";
import type { InboxEntry, ReplyRequest, ReplySubmitRequest } from "@mouthpiece/core";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

function entry(fields: Partial<InboxEntry>): InboxEntry {
  return {
    id: "aaaaaaaa-1",
    source: "claude-code",
    conversationId: "s1",
    label: "web",
    text: "Shall I continue with the migration?",
    at: 0,
    state: "waiting",
    ...fields,
  };
}

function harness(
  entries: InboxEntry[],
  reply: (r: ReplyRequest) => Promise<{ status: "submitted" | "typed" }> = async () => ({
    status: "submitted",
  }),
) {
  const out: string[] = [];
  const err: string[] = [];
  const replies: ReplyRequest[] = [];
  const submits: ReplySubmitRequest[] = [];
  let stdin = "";
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => stdin,
    stdinIsTTY: false,
  };
  const deps: CliDeps = {
    client: {
      speak: async () => ({ id: "abc" }),
      stop: async () => ({ stopped: true, dropped: 0 }),
      skip: async () => ({ skipped: true }),
      health: async () => ({ ok: true, version: "0.1.0", provider: "say", queueDepth: 0 }),
      getMode: async () => ({ default: "summary", overrides: [] }),
      setMode: async () => ({ default: "summary", overrides: [] }),
      replay: async () => ({ id: null }),
      usage: async () => ({ from: "", to: "", rows: [], quotas: [] }),
      status: async () => ({
        version: "0.1.0",
        speaking: false,
        paused: false,
        pauseReasons: [],
        mode: "summary",
        queueDepth: 0,
        provider: "say",
        current: null,
      }),
      pause: async () => ({ paused: true, pauseReasons: ["user"] }),
      resume: async () => ({ paused: false, pauseReasons: [] }),
      voices: async () => ({ providers: [] }),
      inbox: async () => ({ enabled: true, entries }),
      reply: async (r) => {
        replies.push(r);
        return reply(r);
      },
      submitReply: async (r) => {
        submits.push(r);
        return { status: "submitted" };
      },
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    paths: { repoRoot: "/repo", bun: "/bun" },
    now: () => 90_000,
  };
  return {
    io,
    deps,
    out,
    err,
    replies,
    submits,
    setStdin: (s: string) => {
      stdin = s;
    },
  };
}

test("reply by label sends the entry's current id and the text", async () => {
  const h = harness([entry({})]);
  expect(await run(["reply", "web", "yes,", "go"], h.io, h.deps)).toBe(0);
  expect(h.replies).toEqual([{ id: "aaaaaaaa-1", text: "yes, go" }]);
  expect(h.out.join("")).toBe("submitted to web\n");
});

test("reply by id prefix, with the text from stdin", async () => {
  const h = harness([entry({}), entry({ id: "bbbbbbbb-2", conversationId: "s2", label: "api" })]);
  h.setStdin("run it\n");
  expect(await run(["reply", "bbbb"], h.io, h.deps)).toBe(0);
  expect(h.replies).toEqual([{ id: "bbbbbbbb-2", text: "run it" }]);
});

test("two sessions with the same label: refuse and list both", async () => {
  const h = harness([entry({}), entry({ id: "cccccccc-3", conversationId: "s3" })]);
  expect(await run(["reply", "web", "go"], h.io, h.deps)).toBe(2);
  expect(h.replies).toEqual([]);
  expect(h.err.join("")).toContain("aaaaaaaa");
  expect(h.err.join("")).toContain("cccccccc");
});

test("typed but not submitted exits 3 and says how to submit", async () => {
  const h = harness([entry({})], async () => ({ status: "typed" }));
  expect(await run(["reply", "web", "go"], h.io, h.deps)).toBe(3);
  expect(h.out.join("")).toBe(
    "typed into web, not submitted: run mouthpiece reply --submit aaaaaaaa\n",
  );
});

test("a refusal exits 1 with its reason", async () => {
  const h = harness([entry({})], async () => {
    throw new MouthpieceError("the prompt is not empty", 409, "draft");
  });
  expect(await run(["reply", "web", "go"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toBe("mouthpiece: reply refused (draft): the prompt is not empty\n");
});

test("--submit presses Enter for that entry", async () => {
  const h = harness([entry({ state: "typed" })]);
  expect(await run(["reply", "--submit", "web"], h.io, h.deps)).toBe(0);
  expect(h.submits).toEqual([{ id: "aaaaaaaa-1" }]);
});

test("no match, or no text, is a usage error", async () => {
  const h = harness([entry({})]);
  expect(await run(["reply", "nope", "go"], h.io, h.deps)).toBe(2);
  h.setStdin("");
  expect(await run(["reply", "web"], h.io, h.deps)).toBe(2);
  expect(await run(["reply"], h.io, h.deps)).toBe(2);
});

test("an id prefix that is also another session's label is refused, not guessed", async () => {
  const h = harness([
    entry({ id: "cafe0001-1", label: "web" }),
    entry({ id: "bbbbbbbb-2", conversationId: "s2", label: "cafe" }),
  ]);
  expect(await run(["reply", "cafe", "go"], h.io, h.deps)).toBe(2);
  expect(h.replies).toEqual([]);
});

test("an empty target is a usage error", async () => {
  const h = harness([entry({})]);
  expect(await run(["reply", "", "go"], h.io, h.deps)).toBe(2);
  expect(h.replies).toEqual([]);
});
