import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDeps, CliIO } from "../types.ts";
import { daemonCommand } from "./daemon.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-daemon-cmd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 501;
const service = `gui/${uid}/dev.mouthpiece.daemon`;
const plist = () => join(dir, "dev.mouthpiece.daemon.plist");

/**
 * `codes` maps a launchctl subcommand (print, bootout, bootstrap, kickstart) to its exit code;
 * `state` is what `launchctl print` reports for a loaded service.
 */
function harness(codes: Record<string, number> = {}, state = "running") {
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
      const code = codes[cmd[1] ?? ""] ?? 0;
      const stdout =
        cmd[1] === "print" && code === 0
          ? `gui/501/dev.mouthpiece.daemon = {\n\tstate = ${state}\n}\n`
          : "";
      return { code, stdout, stderr: code === 0 ? "" : "launchctl said no" };
    },
    paths: { repoRoot: "/repo", bun: "/u/.bun/bin/bun" },
  };
  const run = (...args: string[]) => daemonCommand(args, io, deps);
  return { run, out, err, calls };
}

test("stop boots a running daemon out of launchd", async () => {
  const h = harness();
  expect(await h.run("stop")).toBe(0);
  expect(h.calls).toEqual([
    ["launchctl", "print", service],
    ["launchctl", "bootout", service],
  ]);
  expect(h.out.join("")).toContain("Daemon stopped");
  expect(h.out.join("")).toContain("mouthpiece daemon start");
});

test("stop when the daemon is not loaded does nothing and succeeds", async () => {
  const h = harness({ print: 113 });
  expect(await h.run("stop")).toBe(0);
  expect(h.calls).toEqual([["launchctl", "print", service]]);
  expect(h.out.join("")).toContain("not running");
});

test("stop reports a failed bootout", async () => {
  const h = harness({ bootout: 5 });
  expect(await h.run("stop")).toBe(1);
  expect(h.err.join("")).toContain("launchctl said no");
});

test("start bootstraps the installed agent", async () => {
  await writeFile(plist(), "<plist/>");
  const h = harness({ print: 113 });
  expect(await h.run("start")).toBe(0);
  expect(h.calls).toEqual([
    ["launchctl", "print", service],
    ["launchctl", "bootstrap", `gui/${uid}`, plist()],
  ]);
  expect(h.out.join("")).toContain("Daemon started");
});

test("start when already running does nothing and succeeds", async () => {
  await writeFile(plist(), "<plist/>");
  const h = harness();
  expect(await h.run("start")).toBe(0);
  expect(h.calls).toEqual([["launchctl", "print", service]]);
  expect(h.out.join("")).toContain("already running");
});

test("start and restart without an installed agent point at install-agent", async () => {
  for (const sub of ["start", "restart"]) {
    const h = harness({ print: 113 });
    expect(await h.run(sub)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain("mouthpiece install-agent");
  }
});

test("start reports a failed bootstrap", async () => {
  await writeFile(plist(), "<plist/>");
  const h = harness({ print: 113, bootstrap: 5 });
  expect(await h.run("start")).toBe(1);
  expect(h.err.join("")).toContain("launchctl said no");
});

test("restart kills and relaunches a running daemon", async () => {
  await writeFile(plist(), "<plist/>");
  const h = harness();
  expect(await h.run("restart")).toBe(0);
  expect(h.calls).toEqual([
    ["launchctl", "print", service],
    ["launchctl", "kickstart", "-k", service],
  ]);
  expect(h.out.join("")).toContain("Daemon restarted");
});

test("restart starts a stopped daemon", async () => {
  await writeFile(plist(), "<plist/>");
  const h = harness({ print: 113 });
  expect(await h.run("restart")).toBe(0);
  expect(h.calls.at(-1)).toEqual(["launchctl", "bootstrap", `gui/${uid}`, plist()]);
  expect(h.out.join("")).toContain("Daemon started");
});

test("a missing or unknown subcommand prints usage and exits 2", async () => {
  for (const args of [[], ["bounce"]]) {
    const h = harness();
    expect(await h.run(...args)).toBe(2);
    expect(h.err.join("")).toContain("mouthpiece daemon start | stop | restart");
    expect(h.calls).toEqual([]);
  }
});

test("start after a Quit (loaded but not running) kickstarts it", async () => {
  await writeFile(plist(), "<plist/>");
  const h = harness({}, "not running");
  expect(await h.run("start")).toBe(0);
  expect(h.calls).toEqual([
    ["launchctl", "print", service],
    ["launchctl", "kickstart", service],
  ]);
  expect(h.out.join("")).toContain("Daemon started");
});

test("stop when loaded but not running still unloads it", async () => {
  const h = harness({}, "not running");
  expect(await h.run("stop")).toBe(0);
  expect(h.calls).toEqual([
    ["launchctl", "print", service],
    ["launchctl", "bootout", service],
  ]);
});

test("start falls back to kickstart when print doesn't say running (harmless if it is)", async () => {
  await writeFile(plist(), "<plist/>");
  const h = harness({}, "some new wording");
  expect(await h.run("start")).toBe(0);
  expect(h.calls.at(-1)).toEqual(["launchctl", "kickstart", service]);
});
