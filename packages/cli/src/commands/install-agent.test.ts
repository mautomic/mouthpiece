import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@mouthpiece/core";
import type { CliDeps, CliIO } from "../types.ts";
import { installAgentCommand } from "./install-agent.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-install-agent-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 501;

function harness(results: Record<string, Partial<ExecResult>> = {}) {
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
    },
    startDaemon: unused,
    env: { MOUTHPIECE_LAUNCH_AGENTS_DIR: dir, MOUTHPIECE_HOME: join(dir, "home") },
    exec: async (cmd) => {
      calls.push(cmd);
      const key = cmd[0] === "launchctl" ? `launchctl ${cmd[1]}` : (cmd[0] ?? "");
      const r = results[key] ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    paths: { repoRoot: "/repo", bun: "/u/.bun/bin/bun" },
  };
  return { io, deps, out, err, calls };
}

const plistPath = () => join(dir, "dev.mouthpiece.daemon.plist");

test("writes the plist and bootstraps it after a bootout", async () => {
  const h = harness({ "/usr/bin/which": { stdout: "/opt/x/claude\n" } });
  expect(await installAgentCommand([], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual([
    ["/usr/bin/which", "claude"],
    ["launchctl", "bootout", `gui/${uid}/dev.mouthpiece.daemon`],
    ["launchctl", "bootstrap", `gui/${uid}`, plistPath()],
  ]);
  const xml = await readFile(plistPath(), "utf8");
  expect(xml).toContain("<string>/u/.bun/bin/bun</string>");
  expect(xml).toContain("<string>/repo/packages/cli/src/main.ts</string>");
  expect(xml).toContain("<key>PATH</key>\n      <string>/u/.bun/bin:/opt/x:");
  expect(xml).toContain(`<key>MOUTHPIECE_HOME</key>\n      <string>${join(dir, "home")}</string>`);
  expect(xml).toContain(`<string>${join(dir, "home", "daemon.log")}</string>`);
  expect(h.out.join("")).toContain("dev.mouthpiece.daemon");
  expect(h.err.join("")).toBe("");
});

test("warns when claude is not on PATH", async () => {
  const h = harness({ "/usr/bin/which": { code: 1 } });
  expect(await installAgentCommand([], h.io, h.deps)).toBe(0);
  expect(await readFile(plistPath(), "utf8")).not.toContain("/opt/x");
  expect(h.err.join("")).toContain("`claude` not found");
});

test("a failing bootstrap exits 1 with its stderr", async () => {
  const h = harness({
    "launchctl bootstrap": { code: 5, stderr: "Bootstrap failed: 5: I/O error\n" },
  });
  expect(await installAgentCommand([], h.io, h.deps)).toBe(1);
  expect(h.err.join("")).toContain("Bootstrap failed: 5: I/O error");
});
