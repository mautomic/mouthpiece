import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interrupt, speak } from "@mouthpiece/client";
import { DEFAULT_CONFIG } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";

let home: string;
let daemon: RunningDaemon;
let player: FakePlayer;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-e2e-"));
  player = new FakePlayer({ durationMs: 40 });
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: join(home, "none.toml") },
    port: 0,
    config: DEFAULT_CONFIG,
    provider: new FakeProvider(),
    player,
    log: () => {},
    hotkeys: false,
    summarizer: null,
  });
});
afterEach(async () => {
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
});

const opts = () => ({ url: daemon.url, env: { MOUTHPIECE_HOME: home } });

test("two conversations play in order with label prefixes once both are active", async () => {
  await speak(
    { text: "First message from web.", source: "test", conversationId: "a", label: "web" },
    opts(),
  );
  await speak(
    { text: "Second message from api.", source: "test", conversationId: "b", label: "api" },
    opts(),
  );
  await daemon.queue.idle();
  expect(player.played).toEqual(["First message from web.", "api: Second message from api."]);
});

test("interrupt stops the rest of a long response", async () => {
  await speak(
    {
      text: "Sentence one is here. Sentence two is here. Sentence three is here.",
      source: "test",
      conversationId: "a",
    },
    opts(),
  );
  await Bun.sleep(10);
  expect(await interrupt({ source: "test", conversationId: "a" }, opts())).toEqual({
    stopped: true,
    dropped: 0,
  });
  await daemon.queue.idle();
  expect(player.played).toEqual(["Sentence one is here."]);
});

test("trivial responses are skipped, alerts are not", async () => {
  expect(await speak({ text: "Done.", source: "test" }, opts())).toEqual({
    id: null,
    skipped: "trivial",
  });
  expect(
    (await speak({ text: "Needs approval.", source: "test", kind: "alert" }, opts())).id,
  ).toBeString();
});

test("requests without the token are rejected", async () => {
  const res = await fetch(`${daemon.url}/v1/speak`, {
    method: "POST",
    body: JSON.stringify({ text: "x", source: "test" }),
  });
  expect(res.status).toBe(401);
});
