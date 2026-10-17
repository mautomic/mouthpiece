import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDeps, CliIO } from "../types.ts";
import { installHooksCommand } from "./install-hooks.ts";

let dir: string;
let settingsPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-install-hooks-"));
  settingsPath = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness() {
  const out: string[] = [];
  const err: string[] = [];
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
    },
    startDaemon: unused,
    env: { MOUTHPIECE_CLAUDE_SETTINGS: settingsPath },
    exec: async () => {
      throw new Error("unexpected exec");
    },
    paths: { repoRoot: "/repo", bun: "/u/.bun/bin/bun" },
  };
  return { io, deps, out, err };
}

type Settings = {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  [k: string]: unknown;
};
const readSettings = async () => JSON.parse(await readFile(settingsPath, "utf8")) as Settings;

test("writes hooks using the configured bun and repo, and prints the path", async () => {
  const h = harness();
  expect(await installHooksCommand([], h.io, h.deps)).toBe(0);
  const s = await readSettings();
  expect(s.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
    '"/u/.bun/bin/bun" "/repo/adapters/claude-code/src/main.ts" stop',
  );
  expect(s.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toEndWith(" prompt");
  expect(s.hooks.Notification?.[0]?.matcher).toBe("permission_prompt");
  expect(h.out.join("")).toContain(settingsPath);
});

test("--idle-alerts adds idle_prompt; existing settings are preserved and backed up", async () => {
  await writeFile(settingsPath, JSON.stringify({ model: "opus", hooks: {} }));
  const h = harness();
  expect(await installHooksCommand(["--idle-alerts"], h.io, h.deps)).toBe(0);
  const s = await readSettings();
  expect(s.model).toBe("opus");
  expect(s.hooks.Notification?.[0]?.matcher).toBe("permission_prompt|idle_prompt");
  expect((await readdir(dir)).some((f) => f.startsWith("settings.json.bak-mouthpiece-"))).toBe(
    true,
  );
  expect(h.out.join("")).toContain("backup");
});

test("re-running is idempotent", async () => {
  const h = harness();
  await installHooksCommand([], h.io, h.deps);
  const first = await readSettings();
  await installHooksCommand([], h.io, h.deps);
  expect(await readSettings()).toEqual(first);
});

test("refuses invalid JSON and leaves the file untouched", async () => {
  await writeFile(settingsPath, "{oops");
  const h = harness();
  await expect(installHooksCommand([], h.io, h.deps)).rejects.toThrow();
  expect(await readFile(settingsPath, "utf8")).toBe("{oops");
});
