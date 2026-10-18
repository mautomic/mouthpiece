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

test("inbox prints one line per entry, then whether replies are on", async () => {
  const h = harness([
    entry({
      id: "bbbbbbbb-2",
      label: "api",
      state: "typed",
      at: 30_000,
      summary: "Deploy is ready.\nApprove?",
    }),
    entry({ at: 85_000 }),
  ]);
  expect(await run(["inbox"], h.io, h.deps)).toBe(0);
  expect(h.out.join("")).toBe(
    "bbbbbbbb  api  typed  1m  Deploy is ready. Approve?\n" +
      "aaaaaaaa  web  waiting  5s  Shall I continue with the migration?\n" +
      "replies: on\n",
  );
});
