import { expect, test } from "bun:test";
import type { ExecResult } from "@mouthpiece/core";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

function harness(opts: { stdin?: string; tty?: boolean; results?: Partial<ExecResult>[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const execCalls: string[][] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => opts.stdin ?? "",
    stdinIsTTY: opts.tty ?? opts.stdin === undefined,
  };
  const unused = async (): Promise<never> => {
    throw new Error("send never talks to the daemon");
  };
  const deps: CliDeps = {
    client: {
      speak: unused,
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
    env: {},
    exec: async (cmd) => {
      execCalls.push(cmd);
      return { code: 0, stdout: "", stderr: "", ...opts.results?.[execCalls.length - 1] };
    },
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, execCalls };
}

test("types positional text into the tmux target and presses Enter", async () => {
  const h = harness();
  expect(await run(["send", "--tmux", "cc", "run", "the", "tests"], h.io, h.deps)).toBe(0);
  expect(h.execCalls).toEqual([
    ["tmux", "-V"],
    ["tmux", "send-keys", "-t", "cc", "-l", "--", "run the tests"],
    ["tmux", "send-keys", "-t", "cc", "Enter"],
  ]);
  expect(h.err.join("")).toContain("sent to cc");
});

test("reads piped stdin when no text is given", async () => {
  const h = harness({ stdin: "fix the build\nplease\n" });
  expect(await run(["send", "--tmux", "cc:1.0"], h.io, h.deps)).toBe(0);
  expect(h.execCalls[1]?.at(-1)).toBe("fix the build please");
});

test("--tmux=<target> form works", async () => {
  const h = harness();
  expect(await run(["send", "--tmux=%3", "hi"], h.io, h.deps)).toBe(0);
  expect(h.execCalls[1]?.slice(2, 4)).toEqual(["-t", "%3"]);
});

test("missing tmux exits 1 with the install hint and sends nothing", async () => {
  const h = harness({ results: [{ code: 127, stderr: "command not found" }] });
  expect(await run(["send", "--tmux", "cc", "hi"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("install tmux: brew install tmux");
  expect(h.execCalls).toEqual([["tmux", "-V"]]);
});

test("without --tmux it exits 2 with usage", async () => {
  const h = harness();
  expect(await run(["send", "hi"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("--tmux <target>");
  expect(h.execCalls).toEqual([]);
});

test("empty text (no args, interactive stdin) exits 2", async () => {
  const h = harness();
  expect(await run(["send", "--tmux", "cc"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("nothing to send");
  expect(h.execCalls).toEqual([]);
});

test("an invalid target exits 2 before running tmux", async () => {
  const h = harness();
  expect(await run(["send", "--tmux", "cc; kill-server", "hi"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("invalid tmux target");
  expect(h.execCalls).toEqual([]);
});

test("a tmux failure exits 1 with its stderr", async () => {
  const h = harness({ results: [{}, { code: 1, stderr: "can't find session: cc" }] });
  expect(await run(["send", "--tmux", "cc", "hi"], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("can't find session: cc");
});

test("an unknown flag exits 2", async () => {
  const h = harness();
  expect(await run(["send", "--tmux", "cc", "--bogus", "hi"], h.io, h.deps)).toBe(2);
});
