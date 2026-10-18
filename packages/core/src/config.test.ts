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
    timeoutMs: 12_000,
    thresholdChars: 300,
    maxChars: 700,
  });
  expect(DEFAULT_CONFIG.hotkeys).toEqual({
    enabled: true,
    stop: "ctrl+alt+s",
    skip: "ctrl+alt+n",
    replay: "ctrl+alt+r",
    toggleMode: "ctrl+alt+m",
  });
  expect(DEFAULT_CONFIG.usage).toEqual({ resetDay: 1, quotas: {}, warnAt: 0.8 });
});

test("phase 3 defaults", () => {
  expect(DEFAULT_CONFIG.provider.elevenlabs).toEqual({
    model: "eleven_flash_v2_5",
    voice: "JBFqnCBsd6RMkjVDRZzb",
  });
  expect(DEFAULT_CONFIG.provider.deepgram).toEqual({ model: "aura-2-thalia-en" });
  expect(DEFAULT_CONFIG.provider.openai).toEqual({ model: "tts-1", voice: "alloy" });
  expect(DEFAULT_CONFIG.voices).toEqual({});
  expect(DEFAULT_CONFIG.usage.warnAt).toBe(0.8);
  expect("monthlyBudgetUsd" in DEFAULT_CONFIG.usage).toBe(false);
  expect(resolveConfig({}).usage.monthlyBudgetUsd).toBeUndefined();
});

test("phase 3 provider settings, voice maps and budget resolve", () => {
  const c = resolveConfig({
    provider: {
      elevenlabs: { voice: "abc" },
      deepgram: { model: "aura-2-orion-en" },
      openai: { model: "gpt-4o-mini-tts", voice: "marin", instructions: "Calm." },
    },
    voices: { say: { web: "Samantha" }, inworld: { api: "Dennis", "my project": "Ashley" } },
    usage: { warnAt: 0.5, monthlyBudgetUsd: 12.5 },
  });
  expect(c.provider.elevenlabs).toEqual({ model: "eleven_flash_v2_5", voice: "abc" });
  expect(c.provider.deepgram).toEqual({ model: "aura-2-orion-en" });
  expect(c.provider.openai).toEqual({
    model: "gpt-4o-mini-tts",
    voice: "marin",
    instructions: "Calm.",
  });
  expect(c.voices).toEqual({
    say: { web: "Samantha" },
    inworld: { api: "Dennis", "my project": "Ashley" },
  });
  expect(c.usage).toMatchObject({ warnAt: 0.5, monthlyBudgetUsd: 12.5 });
});

test("[voices.say] in TOML resolves", async () => {
  const path = join(dir, "config.toml");
  await writeFile(path, '[voices.say]\nweb = "Samantha"\n');
  expect((await loadConfig(path)).voices).toEqual({ say: { web: "Samantha" } });
});

test("profiles and quotas are open-keyed tables", () => {
  const c = resolveConfig({
    profiles: { "claude-code": { mode: "full" }, cron: {} },
    usage: { resetDay: 15, quotas: { inworld: { chars: 275000 } } },
  });
  expect(c.profiles).toEqual({ "claude-code": { mode: "full" }, cron: { mode: undefined } });
  expect(c.usage).toEqual({ resetDay: 15, quotas: { inworld: { chars: 275000 } }, warnAt: 0.8 });
});

test("profiles take an announce setting", () => {
  const c = resolveConfig({
    profiles: { "some-bot": { announce: "never" }, web: { mode: "full", announce: "always" } },
  });
  expect(c.profiles["some-bot"]?.announce).toBe("never");
  expect(c.profiles.web).toEqual({ mode: "full", announce: "always" });
});

test.each([
  [{ modes: { default: "loud" } }, "modes.default"],
  [{ profiles: { x: { mode: "loud" } } }, "profiles.x.mode"],
  [{ profiles: { x: { announce: "sometimes" } } }, "profiles.x.announce"],
  [{ summarizer: { backend: "gpt" } }, "summarizer.backend"],
  [{ usage: { resetDay: 31 } }, "usage.resetDay"],
  [{ usage: { quotas: { inworld: { chars: 0 } } } }, "usage.quotas.inworld.chars"],
  [{ hotkeys: { enabled: "yes" } }, "hotkeys.enabled"],
])("rejects phase 2 %p", (raw, message) => {
  expect(() => resolveConfig(raw)).toThrow(message);
});

test.each([
  [{ voices: "x" }, "voices"],
  [{ voices: { say: "x" } }, "voices.say"],
  [{ voices: { say: { web: "" } } }, "voices.say.web"],
  [{ voices: { say: { web: 3 } } }, "voices.say.web"],
  [{ usage: { warnAt: 1.2 } }, "usage.warnAt"],
  [{ usage: { warnAt: 0 } }, "usage.warnAt"],
  [{ usage: { warnAt: 1 } }, "usage.warnAt"],
  [{ usage: { warnAt: "0.8" } }, "usage.warnAt"],
  [{ usage: { monthlyBudgetUsd: -5 } }, "usage.monthlyBudgetUsd"],
  [{ usage: { monthlyBudgetUsd: 0 } }, "usage.monthlyBudgetUsd"],
  [{ provider: { elevenlabs: { voice: "" } } }, "provider.elevenlabs.voice"],
  [{ provider: { deepgram: { model: 1 } } }, "provider.deepgram.model"],
  [{ provider: { openai: { instructions: "" } } }, "provider.openai.instructions"],
])("rejects phase 3 %p", (raw, message) => {
  expect(() => resolveConfig(raw)).toThrow(message);
});

test("phase 4 defaults", () => {
  expect(DEFAULT_CONFIG.provider.kokoro).toEqual({ voice: "af_heart", speed: 1 });
  expect(DEFAULT_CONFIG.menubar).toEqual({ enabled: true });
  expect(DEFAULT_CONFIG.micPause).toEqual({
    enabled: true,
    ignoreBundleIds: [],
    resumeDelayMs: 800,
    maxPauseMs: 600_000,
  });
  expect(resolveConfig({}).micPause).toEqual(DEFAULT_CONFIG.micPause);
});

test("phase 4 settings resolve", () => {
  const c = resolveConfig({
    provider: { kokoro: { voice: "bm_lewis", speed: 1.5 } },
    menubar: { enabled: false },
    micPause: {
      enabled: false,
      ignoreBundleIds: ["us.zoom.xos"],
      resumeDelayMs: 1200,
      maxPauseMs: 60_000,
    },
  });
  expect(c.provider.kokoro).toEqual({ voice: "bm_lewis", speed: 1.5 });
  expect(c.menubar).toEqual({ enabled: false });
  expect(c.micPause).toEqual({
    enabled: false,
    ignoreBundleIds: ["us.zoom.xos"],
    resumeDelayMs: 1200,
    maxPauseMs: 60_000,
  });
});

test("phase 4 TOML resolves and partial tables keep defaults", async () => {
  const path = join(dir, "config.toml");
  await writeFile(
    path,
    '[provider]\nchain = ["kokoro", "say"]\n[micPause]\nignoreBundleIds = ["us.zoom.xos"]\n',
  );
  const c = await loadConfig(path);
  expect(c.provider.chain).toEqual(["kokoro", "say"]);
  expect(c.provider.kokoro).toEqual({ voice: "af_heart", speed: 1 });
  expect(c.menubar).toEqual({ enabled: true });
  expect(c.micPause).toEqual({ ...DEFAULT_CONFIG.micPause, ignoreBundleIds: ["us.zoom.xos"] });
});

test("phase 4 defaults are not shared mutable state", () => {
  resolveConfig({}).micPause.ignoreBundleIds.push("mutated");
  expect(DEFAULT_CONFIG.micPause.ignoreBundleIds).toEqual([]);
});

test.each([
  [{ provider: { kokoro: "af_heart" } }, "provider.kokoro must be a table"],
  [{ provider: { kokoro: { voice: "" } } }, "provider.kokoro.voice"],
  [{ provider: { kokoro: { voice: 1 } } }, "provider.kokoro.voice"],
  [{ provider: { kokoro: { speed: 0 } } }, "provider.kokoro.speed must be a number from 0.5 to 2"],
  [{ provider: { kokoro: { speed: 0.4 } } }, "provider.kokoro.speed"],
  [{ provider: { kokoro: { speed: 2.5 } } }, "provider.kokoro.speed"],
  [{ provider: { kokoro: { speed: "fast" } } }, "provider.kokoro.speed"],
  [{ menubar: true }, "menubar must be a table"],
  [{ menubar: { enabled: "yes" } }, "menubar.enabled"],
  [{ micPause: { enabled: 1 } }, "micPause.enabled"],
  [{ micPause: { ignoreBundleIds: "us.zoom.xos" } }, "micPause.ignoreBundleIds"],
  [{ micPause: { ignoreBundleIds: [1] } }, "micPause.ignoreBundleIds"],
  [{ micPause: { ignoreBundleIds: [""] } }, "micPause.ignoreBundleIds"],
  [{ micPause: { resumeDelayMs: 0 } }, "micPause.resumeDelayMs"],
  [{ micPause: { resumeDelayMs: -1 } }, "micPause.resumeDelayMs"],
  [{ micPause: { resumeDelayMs: 1.5 } }, "micPause.resumeDelayMs"],
  [{ micPause: { maxPauseMs: 0 } }, "micPause.maxPauseMs"],
  [{ micPause: { maxPauseMs: "600000" } }, "micPause.maxPauseMs"],
  [{ micPause: { maxPauseMs: 86_400_001 } }, "micPause.maxPauseMs must be at most 86400000"],
])("rejects phase 4 %p", (raw, message) => {
  expect(() => resolveConfig(raw)).toThrow(ConfigError);
  expect(() => resolveConfig(raw)).toThrow(message);
});

test("player backend: auto by default, afplay when set, anything else rejected", () => {
  expect(DEFAULT_CONFIG.player).toEqual({ backend: "auto" });
  expect(resolveConfig({}).player).toEqual({ backend: "auto" });
  expect(resolveConfig({ player: { backend: "afplay" } }).player).toEqual({ backend: "afplay" });
  expect(() => resolveConfig({ player: { backend: "vlc" } })).toThrow(
    "player.backend must be one of: auto, afplay",
  );
  expect(() => resolveConfig({ player: "afplay" })).toThrow("player must be a table");
});
