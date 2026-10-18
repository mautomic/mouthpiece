import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, MouthpieceError, status, updateSettings } from "@mouthpiece/client";
import type { SettingsUpdate } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";

let home: string;
let configPath: string;
let daemon: RunningDaemon;

async function boot(configText?: string) {
  home = await mkdtemp(join(tmpdir(), "mp-settings-"));
  configPath = join(home, "config.toml");
  if (configText !== undefined) await writeFile(configPath, configText);
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: configPath },
    port: 0,
    provider: new FakeProvider(),
    player: new FakePlayer(),
    log: () => {},
    summarizer: null,
    hotkeys: false,
    watch: false,
  });
}
afterEach(async () => {
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
});
const o = () => ({ url: daemon.url, env: { MOUTHPIECE_HOME: home } });

/** The HTTP status and message an update is rejected with. */
async function rejected(update: SettingsUpdate): Promise<{ status?: number; message: string }> {
  try {
    await updateSettings(update, o());
  } catch (error) {
    if (error instanceof MouthpieceError) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("update was accepted");
}

const MINE = [
  "# my settings",
  "[provider]",
  'chain = ["kokoro", "say"]',
  "",
  "[provider.kokoro]",
  'voice = "af_bella"   # the warm one',
  "",
  "[modes]",
  'default = "full"',
  "",
].join("\n");

test("GET /v1/settings reports the chain, the Kokoro voice and speed, and every Kokoro voice", async () => {
  await boot(MINE);
  const settings = await getSettings(o());
  expect(settings.chain).toEqual(["kokoro", "say"]);
  expect(settings.kokoro.voice).toBe("af_bella");
  expect(settings.kokoro.speed).toBe(1);
  expect(settings.kokoro.voices).toHaveLength(28);
  expect(settings.kokoro.voices).toContainEqual({
    id: "af_jessica",
    name: "Jessica",
    language: "en-US",
  });
});

test("POST /v1/settings saves to the config file, keeping the rest of it, and applies at once", async () => {
  await boot(MINE);
  const reply = await updateSettings({ kokoro: { voice: "af_jessica", speed: 1.3 } }, o());
  expect(reply.kokoro.voice).toBe("af_jessica");
  expect(reply.kokoro.speed).toBe(1.3);
  expect(await readFile(configPath, "utf8")).toBe(
    [
      "# my settings",
      "[provider]",
      'chain = ["kokoro", "say"]',
      "",
      "[provider.kokoro]",
      'voice = "af_jessica"   # the warm one',
      "speed = 1.3",
      "",
      "[modes]",
      'default = "full"',
      "",
    ].join("\n"),
  );
  expect((await getSettings(o())).kokoro).toMatchObject({ voice: "af_jessica", speed: 1.3 });
  expect((await status(o())).mode).toBe("full"); // the rest of the file still applies
});

test("without a config file, an update creates one", async () => {
  await boot();
  await updateSettings({ kokoro: { speed: 1.5 } }, o());
  expect(await readFile(configPath, "utf8")).toBe("[provider.kokoro]\nspeed = 1.5\n");
  expect((await getSettings(o())).kokoro.speed).toBe(1.5);
});

test("an unknown Kokoro voice or a bad speed is rejected with 400 and the file is left alone", async () => {
  await boot(MINE);
  expect(await rejected({ kokoro: { voice: "am_jessica" } })).toMatchObject({
    status: 400,
    message: expect.stringContaining("am_jessica is not a Kokoro voice"),
  });
  expect(await rejected({ kokoro: { speed: 3 } })).toMatchObject({ status: 400 });
  expect(await readFile(configPath, "utf8")).toBe(MINE);
});

test("a config file with an error, or a layout the editor can't change, is left alone (409)", async () => {
  await boot(MINE);
  await writeFile(configPath, "modes = [");
  expect(await rejected({ kokoro: { speed: 1.2 } })).toMatchObject({
    status: 409,
    message: expect.stringContaining("invalid TOML"),
  });
  expect(await readFile(configPath, "utf8")).toBe("modes = [");

  const inline = '[provider]\nchain = ["kokoro", "say"]\nkokoro = { voice = "af_bella" }\n';
  await writeFile(configPath, inline);
  expect(await rejected({ kokoro: { voice: "af_sky" } })).toMatchObject({
    status: 409,
    message: expect.stringContaining("edit it by hand"),
  });
  expect(await readFile(configPath, "utf8")).toBe(inline);
});

test("a symlinked config file is written through, so the link stays a link", async () => {
  await boot();
  const dotfiles = join(home, "dotfiles");
  await mkdir(dotfiles);
  await writeFile(join(dotfiles, "config.toml"), MINE);
  await symlink(join(dotfiles, "config.toml"), configPath);
  await updateSettings({ kokoro: { speed: 1.3 } }, o());
  expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
  expect(await readFile(join(dotfiles, "config.toml"), "utf8")).toContain("speed = 1.3");
});
