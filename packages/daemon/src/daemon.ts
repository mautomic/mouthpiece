import { join } from "node:path";
import {
  type Config,
  configPath,
  DEFAULT_PORT,
  type Env,
  type Logger,
  loadConfig,
  mouthpieceHome,
  type Player,
  readOrCreateToken,
  type TtsProvider,
} from "@mouthpiece/core";
import { createProviderChain } from "@mouthpiece/providers";
import { createHandler, MAX_BODY_BYTES } from "./handler.ts";
import { jsonLogger } from "./log.ts";
import { AfplayPlayer } from "./player.ts";
import { SpeechQueue } from "./queue.ts";
import { createSpeaker, skipReason } from "./speaker.ts";

export const VERSION = "0.1.0";

export interface DaemonOptions {
  env?: Env;
  port?: number;
  config?: Config;
  provider?: TtsProvider;
  player?: Player;
  log?: Logger;
}

export interface RunningDaemon {
  url: string;
  queue: SpeechQueue;
  stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const home = mouthpieceHome(env);
  const log = opts.log ?? jsonLogger;
  const config = opts.config ?? (await loadConfig(configPath(env)));
  const token = await readOrCreateToken(home);
  const tmpDir = join(home, "tmp");
  const provider = opts.provider ?? createProviderChain(config, { env, tmpDir, log });
  const player = opts.player ?? new AfplayPlayer({ tmpDir });
  const queue = new SpeechQueue({
    play: createSpeaker({ provider, player, log }),
    expireAfterMs: config.queue.expireAfterMs,
    labelWindowMs: config.queue.labelWindowMs,
    onError: (error, item) =>
      log({ level: "error", msg: "play_failed", id: item.id, error: String(error) }),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? Number(env.MOUTHPIECE_PORT || DEFAULT_PORT),
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: createHandler({
      token,
      version: VERSION,
      providerName: () => provider.name,
      queueDepth: () => queue.depth,
      enqueue: (event) => {
        const reason = skipReason(event, config.filter);
        return reason ? { id: null, skipped: reason } : { id: queue.enqueue(event).id };
      },
      interrupt: (r) => queue.interrupt(r.source, r.conversationId),
      stopAll: () => queue.stopAll(),
      skip: () => ({ skipped: queue.skip() }),
    }),
  });
  const url = `http://127.0.0.1:${server.port}`;
  log({ msg: "listening", url, provider: provider.name, version: VERSION });
  return {
    url,
    queue,
    stop: async () => {
      queue.stopAll();
      server.stop(true);
    },
  };
}
