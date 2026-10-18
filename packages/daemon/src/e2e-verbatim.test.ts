import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setMode, speak } from "@mouthpiece/client";
import { resolveConfig, type Summarizer } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { type DaemonOptions, type RunningDaemon, startDaemon } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";

let home: string;
let daemon: RunningDaemon;
let player: FakePlayer;
let summarized: string[];
const long = "The desk posted a new idea on a pullback to support. ".repeat(10); // ~530 chars
const short = "The deploy finished and every check passed.";

async function boot(config: Record<string, unknown> = {}, extra: Partial<DaemonOptions> = {}) {
  home = await mkdtemp(join(tmpdir(), "mp-e2e-verbatim-"));
  player = new FakePlayer({ durationMs: 10 });
  summarized = [];
  const summarizer: Summarizer = {
    name: "fake",
    summarize: async (text) => {
      summarized.push(text);
      return "A summary.";
    },
  };
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: join(home, "config.toml") },
    port: 0,
    provider: new FakeProvider(),
    player,
    log: () => {},
    summarizer,
    hotkeys: false,
    watch: false,
    config: resolveConfig(config),
    ...extra,
  });
}
afterEach(async () => {
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
});
const o = () => ({ url: daemon.url, env: { MOUTHPIECE_HOME: home } });

test("a long verbatim response is spoken in full and never summarized", async () => {
  await boot();
  await speak(
    { text: long, source: "bot", conversationId: "a", verbatim: true, format: "plain" },
    o(),
  );
  await daemon.queue.idle();
  expect(player.played.join(" ")).toBe(long.trim());
  expect(summarized).toEqual([]);
});

test("a short verbatim response is spoken, not dropped as trivial", async () => {
  await boot();
  const r = await speak({ text: "No open positions.", source: "bot", verbatim: true }, o());
  expect(r.id).toBeString();
  await daemon.queue.idle();
  expect(player.played).toEqual(["No open positions."]);
});

test("a verbatim response is still muted by mode off, global or per source", async () => {
  await boot();
  await setMode({ mode: "off" }, o());
  expect(await speak({ text: long, source: "bot", verbatim: true }, o())).toEqual({
    id: null,
    skipped: "muted",
  });
  await setMode({ clear: true }, o());
  await setMode({ mode: "off", source: "bot" }, o());
  expect(await speak({ text: long, source: "bot", verbatim: true }, o())).toEqual({
    id: null,
    skipped: "muted",
  });
  expect(summarized).toEqual([]);
});

test("a source profile's mode off mutes a verbatim response", async () => {
  await boot({ profiles: { bot: { mode: "off" } } });
  expect(await speak({ text: long, source: "bot", verbatim: true }, o())).toEqual({
    id: null,
    skipped: "muted",
  });
});

test("announce always speaks the label for the only active conversation", async () => {
  await boot();
  await speak(
    { text: short, source: "bot", label: "bot", announce: "always", format: "plain" },
    o(),
  );
  await daemon.queue.idle();
  expect(player.played.join(" ")).toBe(`bot: ${short}`);
});

test("a profile's announce never overrides the event's always", async () => {
  await boot({ profiles: { bot: { announce: "never" } } });
  await speak(
    { text: short, source: "bot", label: "bot", announce: "always", format: "plain" },
    o(),
  );
  await daemon.queue.idle();
  expect(player.played.join(" ")).toBe(short);
});
