import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@mouthpiece/core";
import { HOTKEYS_SOURCE } from "@mouthpiece/hotkeys";
import type { CliDeps, CliIO } from "../types.ts";
import { buildHotkeysCommand } from "./build-hotkeys.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-build-hotkeys-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function harness(exec: Exec) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "",
    stdinIsTTY: true,
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used by build-hotkeys");
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
    },
    startDaemon: unused,
    env: { MOUTHPIECE_HOME: home },
    exec,
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err };
}

test("builds the helper into <home>/bin and hints at a daemon restart", async () => {
  const calls: string[][] = [];
  const h = harness(async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  });
  const out = join(home, "bin", "mouthpiece-hotkeys");
  expect(await buildHotkeysCommand([], h.io, h.deps)).toBe(0);
  expect(calls).toEqual([["swiftc", "-O", "-swift-version", "5", "-o", out, HOTKEYS_SOURCE]]);
  expect(h.out.join("")).toContain(out);
  expect(h.out.join("")).toContain("Restart the daemon");
  expect(h.err).toEqual([]);
});

test("swiftc failure exits 1 with the error", async () => {
  const h = harness(async () => ({ code: 1, stdout: "", stderr: "error: cannot find Carbon" }));
  expect(await buildHotkeysCommand([], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("cannot find Carbon");
  expect(h.out).toEqual([]);
});
