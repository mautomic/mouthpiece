import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      status: unused,
      pause: unused,
      resume: unused,
      inbox: unused,
      reply: unused,
      submitReply: unused,
    },
    startDaemon: unused,
    env: {
      MOUTHPIECE_CLAUDE_SETTINGS: settingsPath,
      MOUTHPIECE_CODEX_HOOKS: join(dir, "codex", "hooks.json"),
      MOUTHPIECE_GEMINI_SETTINGS: join(dir, "gemini", "settings.json"),
    },
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
    '"/u/.bun/bin/bun" --config="/repo/bunfig.toml" --no-env-file "/repo/adapters/claude-code/src/main.ts" stop',
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

test("--target claude-code is the default", async () => {
  const h = harness();
  expect(await installHooksCommand(["--target", "claude-code"], h.io, h.deps)).toBe(0);
  const s = await readSettings();
  expect(s.hooks.Stop?.[0]?.hooks[0]?.command).toContain("/repo/adapters/claude-code/src/main.ts");
  expect(h.out.join("")).toContain("New Claude Code sessions will speak.");
});

test("--target codex writes hooks.json only, preserves foreign hooks, and prints the trust note", async () => {
  const codexDir = join(dir, "codex");
  const hooksPath = join(codexDir, "hooks.json");
  await mkdir(codexDir);
  const configToml = 'notify = ["/usr/local/bin/notify"]\n';
  await writeFile(join(codexDir, "config.toml"), configToml);
  const foreign = { hooks: { Stop: [{ hooks: [{ type: "command", command: "/bin/echo hi" }] }] } };
  await writeFile(hooksPath, JSON.stringify(foreign));
  const h = harness();
  expect(await installHooksCommand(["--target", "codex"], h.io, h.deps)).toBe(0);
  const s = JSON.parse(await readFile(hooksPath, "utf8")) as Settings;
  expect(s.hooks.Stop?.[0]).toEqual(foreign.hooks.Stop[0]);
  expect(s.hooks.Stop?.[1]?.hooks[0]?.command).toBe(
    '"/u/.bun/bin/bun" --config="/repo/bunfig.toml" --no-env-file "/repo/adapters/codex/src/main.ts" stop',
  );
  expect(Object.keys(s.hooks).sort()).toEqual([
    "Interrupt",
    "PermissionRequest",
    "Stop",
    "UserPromptSubmit",
  ]);
  expect(await readFile(join(codexDir, "config.toml"), "utf8")).toBe(configToml);
  const files = (await readdir(codexDir)).sort();
  expect(files.filter((f) => !f.startsWith("hooks.json.bak-mouthpiece-"))).toEqual([
    "config.toml",
    "hooks.json",
  ]);
  await expect(stat(settingsPath)).rejects.toThrow();
  expect(h.out.join("")).toContain(hooksPath);
  expect(h.out.join("")).toContain("run /hooks to trust the Mouthpiece hooks");

  await installHooksCommand(["--target", "codex"], h.io, h.deps);
  expect(JSON.parse(await readFile(hooksPath, "utf8"))).toEqual(s);
});

test("--target gemini writes settings.json and keeps unrelated keys", async () => {
  const geminiPath = join(dir, "gemini", "settings.json");
  await mkdir(join(dir, "gemini"));
  await writeFile(geminiPath, JSON.stringify({ theme: "GitHub", mcpServers: { a: {} } }));
  const h = harness();
  expect(await installHooksCommand(["--target", "gemini"], h.io, h.deps)).toBe(0);
  const s = JSON.parse(await readFile(geminiPath, "utf8")) as Settings;
  expect(s.theme).toBe("GitHub");
  expect(s.mcpServers).toEqual({ a: {} });
  expect(Object.keys(s.hooks).sort()).toEqual(["AfterAgent", "BeforeAgent", "Notification"]);
  expect(h.out.join("")).toContain("/hooks panel");
});

test("--target nope exits 2 and writes nothing", async () => {
  const h = harness();
  expect(await installHooksCommand(["--target", "nope"], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("nope");
  expect(await readdir(dir)).toEqual([]);
});
