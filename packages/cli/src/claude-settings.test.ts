import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettingsPath, mergeHooks, removeHooks, updateJsonFile } from "./claude-settings.ts";

const spec = {
  bun: "/u/.bun/bin/bun",
  hookMain: "/repo/adapters/claude-code/src/main.ts",
  idleAlerts: false,
};
const foreign = { type: "command", command: "/usr/local/bin/my-linter" };

test("installs Stop, UserPromptSubmit, Notification as async commands", () => {
  const s = mergeHooks(undefined, spec) as {
    hooks: Record<
      string,
      { matcher?: string; hooks: { type: string; command: string; async: boolean }[] }[]
    >;
  };
  expect(Object.keys(s.hooks).sort()).toEqual(["Notification", "Stop", "UserPromptSubmit"]);
  expect(s.hooks.Stop?.[0]?.hooks[0]).toEqual({
    type: "command",
    command: '"/u/.bun/bin/bun" "/repo/adapters/claude-code/src/main.ts" stop',
    async: true,
  });
  expect(s.hooks.Notification?.[0]?.matcher).toBe("permission_prompt");
  expect(
    (mergeHooks(undefined, { ...spec, idleAlerts: true }) as typeof s).hooks.Notification?.[0]
      ?.matcher,
  ).toBe("permission_prompt|idle_prompt");
});

test("preserves foreign hooks and other keys; idempotent", () => {
  const original = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: { Stop: [{ hooks: [foreign] }] },
  };
  const once = mergeHooks(original, spec);
  const twice = mergeHooks(once, spec);
  expect(twice).toEqual(once);
  expect((once as { permissions: unknown }).permissions).toEqual(original.permissions);
  const stop = (once as { hooks: { Stop: { hooks: unknown[] }[] } }).hooks.Stop;
  expect(stop).toHaveLength(2);
  expect(stop[0]?.hooks).toEqual([foreign]);
});

test("removeHooks removes only ours and prunes empties", () => {
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [foreign] }] } }, spec);
  const { settings, removed } = removeHooks(merged);
  expect(removed).toBe(3);
  expect(settings).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
  expect(removeHooks(mergeHooks({}, spec)).settings).toEqual({});
});

test("non-object settings are rejected", () => {
  expect(() => mergeHooks([], spec)).toThrow("JSON object");
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("updateJsonFile backs up, writes atomically, and refuses invalid JSON", async () => {
  const path = join(dir, "settings.json");
  expect(await updateJsonFile(path, () => ({ a: 1 }), "s1")).toEqual({ backup: null });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ a: 1 });
  expect((await updateJsonFile(path, (c) => ({ ...(c as object), b: 2 }), "s2")).backup).toBe(
    `${path}.bak-mouthpiece-s2`,
  );
  await writeFile(path, "{oops");
  await expect(updateJsonFile(path, () => ({}), "s3")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("{oops");
  expect((await readdir(dir)).some((f) => f.includes(".tmp-"))).toBe(false);
});

test("updateJsonFile writes through a symlink and keeps the file's mode", async () => {
  await mkdir(join(dir, "dotfiles"));
  await mkdir(join(dir, "claude"));
  const target = join(dir, "dotfiles", "settings.json");
  const link = join(dir, "claude", "settings.json");
  await writeFile(target, '{"model":"opus"}', { mode: 0o600 });
  await symlink(target, link);
  const { backup } = await updateJsonFile(link, (c) => ({ ...(c as object), b: 2 }), "s1");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ model: "opus", b: 2 });
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  expect((await stat(backup ?? "")).mode & 0o777).toBe(0o600);
  expect(await readFile(backup ?? "", "utf8")).toBe('{"model":"opus"}');
});

test("updateJsonFile creates a new settings file readable only by the owner", async () => {
  const path = join(dir, "new", "settings.json");
  await updateJsonFile(path, () => ({ a: 1 }), "s1");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("claudeSettingsPath precedence", () => {
  expect(claudeSettingsPath({ MOUTHPIECE_CLAUDE_SETTINGS: "/x.json" })).toBe("/x.json");
  expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/settings.json");
  expect(claudeSettingsPath({})).toEndWith("/.claude/settings.json");
});
