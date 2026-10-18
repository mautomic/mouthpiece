import { expect, test } from "bun:test";
import type { Exec, ExecResult } from "@mouthpiece/core";
import { OrcaReplyDriver } from "./driver.ts";

const route = { via: "orca", target: "term_abc", agent: "claude" } as const;
const RULE = "─".repeat(60);
const idleTail = [
  "✻ Crunched for 25s · done 4:51 PM",
  RULE,
  "❯",
  RULE,
  "  ⏵⏵ bypass permissions on",
];

function ok(result: unknown): ExecResult {
  return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
}
function show(terminal: Record<string, unknown>): ExecResult {
  return ok({
    terminal: {
      handle: "term_abc",
      connected: true,
      writable: true,
      agentIdentity: "claude",
      ...terminal,
    },
  });
}
function read(terminal: Record<string, unknown>): ExecResult {
  return ok({
    terminal: {
      handle: "term_abc",
      status: "running",
      source: "screen",
      tail: idleTail,
      ...terminal,
    },
  });
}

function fake(replies: Record<string, ExecResult>) {
  const calls: { cmd: string[]; timeoutMs?: number }[] = [];
  const exec: Exec = async (cmd, opts) => {
    calls.push({ cmd, timeoutMs: opts?.timeoutMs });
    return replies[cmd[2] as string] ?? { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { driver: new OrcaReplyDriver({ exec, orca: "/bin/orca" }), calls };
}

test("check passes for the same agent, idle, with an empty prompt", async () => {
  const { driver, calls } = fake({ show: show({}), read: read({}) });
  expect(await driver.check(route)).toEqual({ ok: true });
  expect(calls).toEqual([
    {
      cmd: ["/bin/orca", "terminal", "show", "--terminal", "term_abc", "--json"],
      timeoutMs: 3000,
    },
    {
      cmd: [
        "/bin/orca",
        "terminal",
        "read",
        "--terminal",
        "term_abc",
        "--screen",
        "--limit",
        "15",
        "--json",
      ],
      timeoutMs: 3000,
    },
  ]);
});

test("check: an Orca error, or a closed terminal, is gone", async () => {
  const error = {
    code: 1,
    stdout: JSON.stringify({ ok: false, error: { code: "not_found", message: "x" } }),
    stderr: "",
  };
  expect(await fake({ show: error }).driver.check(route)).toEqual({ ok: false, reason: "gone" });
  expect(await fake({ show: show({ connected: false }) }).driver.check(route)).toEqual({
    ok: false,
    reason: "gone",
  });
  expect(await fake({ show: show({ writable: false }) }).driver.check(route)).toEqual({
    ok: false,
    reason: "gone",
  });
});

test("check: a missing binary or garbled output is unverified, not gone", async () => {
  const missing = { code: 127, stdout: "", stderr: "ENOENT" };
  expect(await fake({ show: missing }).driver.check(route)).toEqual({
    ok: false,
    reason: "unverified",
  });
  expect(
    await fake({ show: { code: 0, stdout: "not json", stderr: "" } }).driver.check(route),
  ).toEqual({ ok: false, reason: "unverified" });
});

test("check: another program in the terminal is not-agent", async () => {
  expect(await fake({ show: show({ agentIdentity: null }) }).driver.check(route)).toEqual({
    ok: false,
    reason: "not-agent",
  });
  expect(await fake({ show: show({ agentIdentity: "codex" }) }).driver.check(route)).toEqual({
    ok: false,
    reason: "not-agent",
  });
});

test("check: no rendered screen is unverified; Orca composer text is a draft", async () => {
  expect(
    await fake({ show: show({}), read: read({ source: "stream" }) }).driver.check(route),
  ).toEqual({ ok: false, reason: "unverified" });
  expect(await fake({ show: show({}), read: read({ draft: "half" }) }).driver.check(route)).toEqual(
    { ok: false, reason: "draft" },
  );
});

test("check with typed text accepts a prompt that starts with it", async () => {
  const tail = ["✻ Done", RULE, "❯ go ahead with the plan", RULE];
  const { driver } = fake({ show: show({}), read: read({ tail }) });
  expect(await driver.check(route, "go ahead with the plan")).toEqual({ ok: true });
});

test("send types the text, presses Enter and waits for submission", async () => {
  const { driver, calls } = fake({ send: ok({}) });
  expect(await driver.send(route, "-- go ahead; rm nothing")).toEqual({ submitted: false });
  expect(calls).toEqual([
    {
      cmd: [
        "/bin/orca",
        "terminal",
        "send",
        "--terminal",
        "term_abc",
        "--text",
        "-- go ahead; rm nothing",
        "--enter",
        "--wait-submit",
        "5",
        "--json",
      ],
      timeoutMs: 8000,
    },
  ]);
});

test("send with empty text presses Enter alone", async () => {
  const { driver, calls } = fake({ send: ok({}) });
  await driver.send(route, "");
  expect(calls[0]?.cmd).toEqual([
    "/bin/orca",
    "terminal",
    "send",
    "--terminal",
    "term_abc",
    "--enter",
    "--wait-submit",
    "5",
    "--json",
  ]);
});

test("send throws on failure, without the text in the message", async () => {
  const failed = {
    code: 1,
    stdout: JSON.stringify({ ok: false, error: { code: "invalid_argument", message: "bad" } }),
    stderr: "",
  };
  const { driver } = fake({ send: failed });
  const error = await driver.send(route, "secret reply").catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("invalid_argument");
  expect((error as Error).message).not.toContain("secret reply");
});
