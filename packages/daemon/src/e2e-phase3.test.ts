import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { health, speak, usage, voices } from "@mouthpiece/client";
import {
  type Config,
  type ProviderUsage,
  resolveConfig,
  type Summarizer,
  type VoiceInfo,
} from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { type DaemonOptions, type RunningDaemon, startDaemon } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";
import { writeUntil } from "./write-until.ts";

let home: string;
let daemon: RunningDaemon;
let player: FakePlayer;

/** A fake that can list voices and report its own usage. */
class VoicedFake extends FakeProvider {
  constructor(
    name: string,
    private readonly list: VoiceInfo[] | Error,
    private readonly reported?: ProviderUsage,
    pricePerMillionChars = 0,
  ) {
    super({ name, pricePerMillionChars });
  }
  async listVoices(): Promise<VoiceInfo[]> {
    if (this.list instanceof Error) throw this.list;
    return this.list;
  }
  async usageStatus(): Promise<ProviderUsage | undefined> {
    return this.reported;
  }
}

async function boot(config: Config, extra: Partial<DaemonOptions> = {}) {
  home = await mkdtemp(join(tmpdir(), "mp-e2e3-"));
  player = new FakePlayer();
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: join(home, "config.toml") },
    port: 0,
    player,
    log: () => {},
    summarizer: null,
    hotkeys: false,
    watch: false,
    config,
    ...extra,
  });
}
afterEach(async () => {
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
});
const o = () => ({ url: daemon.url, env: { MOUTHPIECE_HOME: home } });
const sayChain = (raw: Record<string, unknown> = {}) =>
  resolveConfig({ provider: { chain: ["say"] }, ...raw });

test("the per-label voice map picks the voice; an explicit voice overrides it (US-015)", async () => {
  const fake = new FakeProvider();
  await boot(sayChain({ voices: { fake: { web: "V-web" } } }), { providers: [fake] });
  const base = { source: "cli", label: "web", format: "plain", mode: "full" } as const;
  await speak({ ...base, text: "The build is green again." }, o());
  await daemon.queue.idle();
  await speak({ ...base, text: "The deploy finished cleanly.", voice: "V-cli" }, o());
  await daemon.queue.idle();
  await speak({ ...base, label: "api", text: "Another project entirely." }, o());
  await daemon.queue.idle();
  expect(fake.options.map((x) => x.voice)).toEqual(["V-web", "V-cli", undefined]);
  expect(fake.options.map((x) => x.label)).toEqual(["web", "web", "api"]);
});

test("quota: a spoken 85% notice, then 'used up' and fallback to say (US-016)", async () => {
  const inworld = new FakeProvider({ name: "inworld", pricePerMillionChars: 10 });
  const say = new FakeProvider({ name: "say" });
  await boot(sayChain({ usage: { quotas: { inworld: { chars: 1000 } } } }), {
    providers: [inworld, say],
  });
  expect((await health(o())).provider).toBe("inworld>say");
  const first = "x".repeat(849);
  await speak({ text: `${first}.`, source: "cli", format: "plain", mode: "full" }, o());
  await daemon.queue.idle();
  const warn = "Inworld has used 85% of its monthly quota.";
  expect(player.played).toEqual([`${first}.`, warn]);
  // The notice itself was synthesized by inworld (it was not blocked yet), so it counts too.
  expect(inworld.calls).toEqual([`${first}.`, warn]);
  expect((await usage(o())).quotas[0]).toMatchObject({
    provider: "inworld",
    usedChars: 850 + warn.length,
    level: "warn",
  });

  const second = `${"y".repeat(199)}.`;
  await speak({ text: second, source: "cli", format: "plain", mode: "full" }, o());
  await daemon.queue.idle();
  // The notice is chunked by sentence; inworld is skipped from then on, so say speaks all of it.
  const usedUp = player.played.slice(3);
  expect(usedUp.join(" ")).toStartWith("Inworld quota is used up. Using the system voice until ");
  expect(player.played[2]).toBe(second);
  expect(say.calls).toEqual(usedUp);
  // Two quota notices played, but they are not conversations: a labeled event from the only real
  // session is spoken without its label prefix.
  await speak(
    { text: "After the quota ran out.", source: "cli", label: "web", format: "plain" },
    o(),
  );
  await daemon.queue.idle();
  expect(say.calls.at(-1)).toBe("After the quota ran out.");
  expect(inworld.calls).toHaveLength(3);

  const report = await usage(o());
  expect(report.quotas).toEqual([
    expect.objectContaining({ provider: "inworld", level: "exceeded" }),
  ]);
  expect(report.rows).toContainEqual(
    expect.objectContaining({ provider: "inworld", source: "mouthpiece", requests: 1 }),
  );
  expect(report.rows).toContainEqual(
    expect.objectContaining({ provider: "say", source: "mouthpiece", requests: usedUp.length }),
  );
});

test("quota: the monthly budget blocks paid providers but never say (US-016)", async () => {
  const inworld = new FakeProvider({ name: "inworld", pricePerMillionChars: 10 });
  const say = new FakeProvider({ name: "say" });
  // 10 USD per 1M chars, so 1000 chars cost 0.01 USD: the whole budget.
  await boot(sayChain({ usage: { monthlyBudgetUsd: 0.01 } }), { providers: [inworld, say] });
  await speak({ text: `${"z".repeat(999)}.`, source: "cli", format: "plain", mode: "full" }, o());
  await daemon.queue.idle();
  const notice = player.played.slice(1);
  expect(notice.join(" ")).toStartWith(
    "Mouthpiece's $0.01 monthly budget is used up. Using the system voice until ",
  );
  // Blocked by the budget, inworld is skipped; say is free and never blocked.
  expect(say.calls).toEqual(notice);
  expect(inworld.calls).toHaveLength(1);
  const report = await usage(o());
  expect(report.budget).toMatchObject({ limitUsd: 0.01, level: "exceeded" });
});

test("voices: one entry per provider, error entries for failures, ?provider= filters (US-015)", async () => {
  const listed = [{ id: "V1", name: "Voice One", language: "en" }];
  await boot(sayChain(), {
    providers: [
      new VoicedFake("elevenlabs", listed),
      new VoicedFake("openai", new Error("HTTP 401: bad key")),
      new FakeProvider({ name: "say" }),
    ],
  });
  expect(await voices(o())).toEqual({
    providers: [
      { provider: "elevenlabs", voices: listed },
      { provider: "openai", voices: [], error: "HTTP 401: bad key" },
      { provider: "say", voices: [] },
    ],
  });
  expect(await voices({ ...o(), provider: "elevenlabs" })).toEqual({
    providers: [{ provider: "elevenlabs", voices: listed }],
  });
  expect(await voices({ ...o(), provider: "deepgram" })).toEqual({
    providers: [{ provider: "deepgram", voices: [], error: "not in the active provider chain" }],
  });
});

test("usage attaches provider-reported usage to the matching quota (US-016)", async () => {
  const reported = { usedChars: 1234, limitChars: 40_000, resetsAt: "2026-11-01T00:00:00.000Z" };
  const eleven = new VoicedFake("elevenlabs", [], reported, 40);
  await boot(sayChain({ usage: { quotas: { elevenlabs: { chars: 40_000 } } } }), {
    providers: [eleven, new FakeProvider({ name: "say" })],
  });
  const report = await usage(o());
  expect(report.quotas).toEqual([
    expect.objectContaining({ provider: "elevenlabs", providerReported: reported }),
  ]);
});

test("summarizer calls are recorded in the usage report (US-016)", async () => {
  const summarizer: Summarizer = { name: "fake", summarize: async () => "Short summary." };
  await boot(resolveConfig({}), { provider: new FakeProvider(), summarizer });
  await speak(
    { text: "I changed the queue so alerts jump ahead. ".repeat(10), source: "cli" },
    o(),
  );
  await daemon.queue.idle();
  expect(player.played).toEqual(["Short summary."]);
  expect((await usage(o())).summaries).toMatchObject({ calls: 1, failures: 0 });
});

test("hot reload applies a new per-label voice map", async () => {
  home = await mkdtemp(join(tmpdir(), "mp-e2e3-"));
  const configPath = join(home, "config.toml");
  await writeFile(configPath, '[provider]\nchain = ["say"]\n[voices.fake]\nweb = "V1"\n');
  const logs: Record<string, unknown>[] = [];
  const fake = new FakeProvider();
  player = new FakePlayer();
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: configPath },
    port: 0,
    providers: [fake],
    player,
    log: (r) => logs.push(r),
    summarizer: null,
    hotkeys: false,
  });
  await writeUntil(configPath, '[provider]\nchain = ["say"]\n[voices.fake]\nweb = "V2"\n', () =>
    logs.some((l) => l.msg === "config_reloaded"),
  );
  const text = "The voice map was reloaded.";
  expect(
    (await speak({ text, source: "cli", label: "web", format: "plain" }, o())).id,
  ).toBeString();
  await daemon.queue.idle();
  expect(fake.options.map((x) => x.voice)).toEqual(["V2"]);
}, 20_000);
