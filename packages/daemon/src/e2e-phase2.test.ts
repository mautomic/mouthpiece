import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMode, replay, setMode, speak, usage } from "@mouthpiece/client";
import { resolveConfig, type Summarizer } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { type DaemonOptions, type RunningDaemon, startDaemon } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";
import { writeUntil } from "./write-until.ts";

let home: string;
let daemon: RunningDaemon;
let player: FakePlayer;
const long = "I changed the queue so alerts jump ahead. ".repeat(10); // ~430 chars
const summarizer: Summarizer = {
  name: "fake",
  summarize: async () => "Queue now prioritizes alerts.",
};

async function boot(extra: Partial<DaemonOptions> = {}) {
  home = await mkdtemp(join(tmpdir(), "mp-e2e2-"));
  player = new FakePlayer({ durationMs: 10 });
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: join(home, "config.toml") },
    port: 0,
    provider: new FakeProvider(),
    player,
    log: () => {},
    summarizer,
    hotkeys: false,
    watch: false,
    config: resolveConfig({}),
    ...extra,
  });
}
afterEach(async () => {
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
});
const o = () => ({ url: daemon.url, env: { MOUTHPIECE_HOME: home } });

test("summary mode speaks the summary; replay --full speaks the full text", async () => {
  await boot();
  await speak({ text: long, source: "claude-code", conversationId: "s1" }, o());
  await daemon.queue.idle();
  expect(player.played).toEqual(["Queue now prioritizes alerts."]);
  expect((await replay({ full: true }, o())).id).toBeString();
  await daemon.queue.idle();
  expect(player.played.slice(1).join(" ")).toBe(long.trim());
});

test("a plain replay does not replace the full text kept for replay --full", async () => {
  await boot();
  await speak({ text: long, source: "claude-code", conversationId: "s1" }, o());
  await daemon.queue.idle();
  await replay({}, o());
  await daemon.queue.idle();
  expect(player.played).toEqual(["Queue now prioritizes alerts.", "Queue now prioritizes alerts."]);
  await replay({ full: true }, o());
  await daemon.queue.idle();
  expect(player.played.slice(2).join(" ")).toBe(long.trim());
  expect(daemon.history.size).toBe(1);
});

test("mode off mutes responses but not alerts; toggle flips global mode", async () => {
  await boot();
  await setMode({ mode: "off" }, o());
  expect(await speak({ text: long, source: "cli" }, o())).toEqual({ id: null, skipped: "muted" });
  expect(
    (await speak({ text: "Needs approval.", source: "cli", kind: "alert" }, o())).id,
  ).toBeString();
  expect((await setMode({ toggle: true }, o())).default).toBe("summary");
  expect((await getMode(o())).default).toBe("summary");
});

test("repeated alert is a duplicate", async () => {
  await boot();
  await speak(
    {
      text: "web needs your approval.",
      source: "claude-code",
      conversationId: "s1",
      kind: "alert",
    },
    o(),
  );
  expect(
    await speak(
      {
        text: "web needs your approval.",
        source: "claude-code",
        conversationId: "s1",
        kind: "alert",
      },
      o(),
    ),
  ).toEqual({
    id: null,
    skipped: "duplicate",
  });
});

test("usage is metered by source", async () => {
  await boot();
  await speak({ text: "A response long enough to be spoken.", source: "cli" }, o());
  await daemon.queue.idle();
  const report = await usage(o());
  expect(report.rows).toContainEqual(
    expect.objectContaining({ provider: "fake", source: "cli", requests: 1 }),
  );
});

test("hot reload applies valid config and keeps the old one on a bad edit", async () => {
  home = await mkdtemp(join(tmpdir(), "mp-e2e2-"));
  const configPath = join(home, "config.toml");
  await writeFile(configPath, '[modes]\ndefault = "summary"\n');
  const logs: Record<string, unknown>[] = [];
  player = new FakePlayer();
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: configPath },
    port: 0,
    provider: new FakeProvider(),
    player,
    log: (r) => logs.push(r),
    summarizer,
    hotkeys: false,
  });
  await writeUntil(
    configPath,
    '[modes]\ndefault = "full"\n',
    async () => (await getMode(o())).default === "full",
  );
  await writeUntil(configPath, "modes = [", () =>
    logs.some((l) => l.msg === "config_reload_failed"),
  );
  expect((await getMode(o())).default).toBe("full");
}, 20_000);
