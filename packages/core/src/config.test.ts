import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, configPath, DEFAULT_CONFIG, loadConfig, resolveConfig } from "./config.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("missing file yields defaults", async () => {
  expect(await loadConfig(join(dir, "nope.toml"))).toEqual(DEFAULT_CONFIG);
});

test("partial TOML overrides only what it sets", async () => {
  const path = join(dir, "config.toml");
  await writeFile(
    path,
    '[provider]\nchain = ["inworld", "say"]\n[provider.inworld]\nvoice = "Dennis"\n[queue]\nexpireAfterMs = 1000\n',
  );
  const config = await loadConfig(path);
  expect(config.provider.chain).toEqual(["inworld", "say"]);
  expect(config.provider.inworld).toEqual({ model: "inworld-tts-2-flash", voice: "Dennis" });
  expect(config.queue).toEqual({ expireAfterMs: 1000, labelWindowMs: 600_000 });
  expect(config.filter).toEqual(DEFAULT_CONFIG.filter);
});

test("invalid TOML names the file", async () => {
  const path = join(dir, "bad.toml");
  await writeFile(path, "provider = [");
  await expect(loadConfig(path)).rejects.toThrow(path);
});

test.each([
  [{ provider: { chain: [] } }, "provider.chain"],
  [{ provider: { chain: "say" } }, "provider.chain"],
  [{ queue: { expireAfterMs: -1 } }, "queue.expireAfterMs"],
  [{ filter: { minChars: 1.5 } }, "filter.minChars"],
  [{ provider: "say" }, "provider must be a table"],
])("rejects %p", (raw, message) => {
  expect(() => resolveConfig(raw)).toThrow(ConfigError);
  expect(() => resolveConfig(raw)).toThrow(message);
});

test("configPath honors MOUTHPIECE_CONFIG", () => {
  expect(configPath({ MOUTHPIECE_CONFIG: "/tmp/x.toml" })).toBe("/tmp/x.toml");
  expect(configPath({})).toEndWith("/.config/mouthpiece/config.toml");
});

test("defaults are not shared mutable state", async () => {
  const a = await loadConfig(join(dir, "nope.toml"));
  a.provider.chain.push("mutated");
  expect(DEFAULT_CONFIG.provider.chain).toEqual(["say"]);
});

test("phase 2 defaults", () => {
  expect(DEFAULT_CONFIG.modes).toEqual({ default: "summary" });
  expect(DEFAULT_CONFIG.summarizer).toEqual({
    backend: "claude-cli",
    command: "claude",
    model: "haiku",
    timeoutMs: 6000,
    thresholdChars: 300,
    maxChars: 350,
  });
  expect(DEFAULT_CONFIG.hotkeys).toEqual({
    enabled: true,
    stop: "ctrl+alt+s",
    skip: "ctrl+alt+n",
    replay: "ctrl+alt+r",
    toggleMode: "ctrl+alt+m",
  });
  expect(DEFAULT_CONFIG.usage).toEqual({ resetDay: 1, quotas: {} });
});

test("profiles and quotas are open-keyed tables", () => {
  const c = resolveConfig({
    profiles: { "claude-code": { mode: "full" }, cron: {} },
    usage: { resetDay: 15, quotas: { inworld: { chars: 275000 } } },
  });
  expect(c.profiles).toEqual({ "claude-code": { mode: "full" }, cron: { mode: undefined } });
  expect(c.usage).toEqual({ resetDay: 15, quotas: { inworld: { chars: 275000 } } });
});

test.each([
  [{ modes: { default: "loud" } }, "modes.default"],
  [{ profiles: { x: { mode: "loud" } } }, "profiles.x.mode"],
  [{ summarizer: { backend: "gpt" } }, "summarizer.backend"],
  [{ usage: { resetDay: 31 } }, "usage.resetDay"],
  [{ usage: { quotas: { inworld: { chars: 0 } } } }, "usage.quotas.inworld.chars"],
  [{ hotkeys: { enabled: "yes" } }, "hotkeys.enabled"],
])("rejects phase 2 %p", (raw, message) => {
  expect(() => resolveConfig(raw)).toThrow(message);
});
