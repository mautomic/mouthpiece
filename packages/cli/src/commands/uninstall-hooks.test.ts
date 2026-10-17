import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDeps, CliIO } from "../types.ts";
import { installHooksCommand } from "./install-hooks.ts";
import { uninstallHooksCommand } from "./uninstall-hooks.ts";

let dir: string;
let settingsPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-uninstall-hooks-"));
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

const foreign = { type: "command", command: "/usr/local/bin/my-linter" };

test("removes our hooks and keeps everything else", async () => {
  await writeFile(
    settingsPath,
    JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [foreign] }] } }),
  );
  const h = harness();
  await installHooksCommand([], h.io, h.deps);
  expect(await uninstallHooksCommand([], h.io, h.deps)).toBe(0);
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
    model: "opus",
    hooks: { Stop: [{ hooks: [foreign] }] },
  });
  expect(h.out.join("")).toContain(`Removed Mouthpiece hooks from ${settingsPath}`);
});

test("a second uninstall finds nothing and does not touch the file", async () => {
  const h = harness();
  await installHooksCommand([], h.io, h.deps);
  await uninstallHooksCommand([], h.io, h.deps);
  const before = await stat(settingsPath);
  const content = await readFile(settingsPath, "utf8");
  const again = harness();
  expect(await uninstallHooksCommand([], again.io, again.deps)).toBe(0);
  expect(again.out.join("")).toMatch(/no Mouthpiece hooks found/i);
  expect((await stat(settingsPath)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(settingsPath, "utf8")).toBe(content);
});

test("a missing settings file is not created", async () => {
  const h = harness();
  expect(await uninstallHooksCommand([], h.io, h.deps)).toBe(0);
  expect(h.out.join("")).toMatch(/no Mouthpiece hooks found/i);
  await expect(stat(settingsPath)).rejects.toThrow();
});

test("invalid JSON is refused and left untouched", async () => {
  await writeFile(settingsPath, "{oops");
  const h = harness();
  await expect(uninstallHooksCommand([], h.io, h.deps)).rejects.toThrow();
  expect(await readFile(settingsPath, "utf8")).toBe("{oops");
});
