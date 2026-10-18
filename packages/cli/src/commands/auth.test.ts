import { expect, test } from "bun:test";
import type { CliDeps, CliIO } from "../types.ts";
import { authCommand } from "./auth.ts";

function harness(opts: { stdin?: string; tty?: boolean; code?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const stdins: (string | undefined)[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => opts.stdin ?? "",
    stdinIsTTY: opts.tty ?? false,
  };
  const unused = async (): Promise<never> => {
    throw new Error("unexpected client call");
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
    exec: async (cmd, o) => {
      calls.push(cmd);
      stdins.push(o?.stdin);
      return { code: opts.code ?? 0, stdout: "", stderr: "" };
    },
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, calls, stdins };
}

test("stores a piped key in the Keychain", async () => {
  const h = harness({ stdin: "key\n", tty: false });
  expect(await authCommand(["inworld"], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual([["/usr/bin/security", "-i"]]);
  expect(h.stdins).toEqual(['add-generic-password -U -s mouthpiece -a "inworld" -w "key"\n']);
  expect(h.out.join("")).toContain("Stored inworld key");
});

test("a TTY stdin exits 2 and asks to pipe the key in", async () => {
  const h = harness({ tty: true });
  expect(await authCommand(["inworld"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("pipe the key in");
  expect(h.calls).toEqual([]);
});

test("an empty key exits 2", async () => {
  const h = harness({ stdin: "  \n", tty: false });
  expect(await authCommand(["inworld"], h.io, h.deps)).toBe(2);
  expect(h.calls).toEqual([]);
});

test("--delete removes the Keychain item", async () => {
  const h = harness();
  expect(await authCommand(["inworld", "--delete"], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual([
    ["/usr/bin/security", "delete-generic-password", "-s", "mouthpiece", "-a", "inworld"],
  ]);
  expect(h.out.join("")).toContain("Removed inworld key");
  const missing = harness({ code: 44 });
  expect(await authCommand(["inworld", "--delete"], missing.io, missing.deps)).toBe(0);
  expect(missing.out.join("")).toContain("No inworld key");
});

test.each([[["Bad Name"]], [[]]])("invalid provider name %p exits 2", async (args) => {
  const h = harness({ stdin: "key\n" });
  expect(await authCommand(args, h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("usage: mouthpiece auth");
  expect(h.calls).toEqual([]);
});
