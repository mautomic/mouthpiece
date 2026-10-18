import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDeps, CliIO } from "../types.ts";
import { uninstallAgentCommand } from "./uninstall-agent.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-uninstall-agent-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 501;

function harness(bootoutCode = 0) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "",
    stdinIsTTY: true,
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
    env: { MOUTHPIECE_LAUNCH_AGENTS_DIR: dir, MOUTHPIECE_HOME: join(dir, "home") },
    exec: async (cmd) => {
      calls.push(cmd);
      return { code: bootoutCode, stdout: "", stderr: "" };
    },
    paths: { repoRoot: "/repo", bun: "/u/.bun/bin/bun" },
  };
  return { io, deps, out, err, calls };
}

test("boots the agent out and removes the plist", async () => {
  await writeFile(join(dir, "dev.mouthpiece.daemon.plist"), "<plist/>");
  const h = harness();
  expect(await uninstallAgentCommand([], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual([["launchctl", "bootout", `gui/${uid}/dev.mouthpiece.daemon`]]);
  expect(await readdir(dir)).toEqual([]);
  expect(h.out.join("")).toContain("Removed launchd agent dev.mouthpiece.daemon");
});

test("a missing plist and an unloaded agent still exit 0", async () => {
  const h = harness(3);
  expect(await uninstallAgentCommand([], h.io, h.deps)).toBe(0);
  expect(h.calls).toHaveLength(1);
});
