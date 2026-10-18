import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { health, shutdown } from "@mouthpiece/client";
import { resolveConfig } from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";

let home: string;
let daemon: RunningDaemon;
afterEach(async () => {
  await daemon.stop(); // stopping again is safe
  await rm(home, { recursive: true, force: true });
});

test("POST /v1/shutdown stops the daemon, then tells its owner so it can exit (menubar Quit)", async () => {
  home = await mkdtemp(join(tmpdir(), "mp-shutdown-"));
  const logs: Record<string, unknown>[] = [];
  let resolveShutdown: () => void = () => {};
  const shutDown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: join(home, "config.toml") },
    port: 0,
    provider: new FakeProvider(),
    player: new FakePlayer(),
    log: (r) => logs.push(r),
    summarizer: null,
    hotkeys: false,
    watch: false,
    config: resolveConfig({}),
    onShutdown: resolveShutdown,
  });
  const o = { url: daemon.url, env: { MOUTHPIECE_HOME: home } };
  expect(await shutdown(o)).toEqual({ stopping: true });
  await shutDown; // onShutdown runs after the daemon has stopped
  expect(logs).toContainEqual(expect.objectContaining({ msg: "shutdown_requested" }));
  await expect(health({ ...o, timeoutMs: 300 })).rejects.toThrow();
});
