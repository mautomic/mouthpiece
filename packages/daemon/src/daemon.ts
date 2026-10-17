import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  configPath,
  DEFAULT_PORT,
  defaultExec,
  type Env,
  type Exec,
  type Logger,
  loadConfig,
  mouthpieceHome,
  type NormalizedSpeakEvent,
  type Player,
  readOrCreateToken,
  resolveSecret,
  type SpeakResponse,
  type Summarizer,
  type SynthesizeOptions,
  type TtsProvider,
  tokenPath,
} from "@mouthpiece/core";
import { helperArgs, hotkeysBinary, superviseHotkeys } from "@mouthpiece/hotkeys";
import { createProviderChain } from "@mouthpiece/providers";
import { createSummarizer, FirstSentencesSummarizer } from "@mouthpiece/summarizers";
import { CachingProvider } from "./cache.ts";
import { AlertDeduper } from "./dedupe.ts";
import { createHandler, MAX_BODY_BYTES } from "./handler.ts";
import { History } from "./history.ts";
import { jsonLogger } from "./log.ts";
import { ModeStore } from "./modes.ts";
import { AfplayPlayer } from "./player.ts";
import { createPreparer } from "./prepare.ts";
import { SpeechQueue } from "./queue.ts";
import { createSpeaker, skipReason } from "./speaker.ts";
import { billingCycle, MeteredProvider, monthRange, UsageStore } from "./usage.ts";
import { watchConfig } from "./watch.ts";

export const VERSION = "0.2.0";

export interface DaemonOptions {
  env?: Env;
  port?: number;
  config?: Config;
  provider?: TtsProvider;
  player?: Player;
  log?: Logger;
  /** null disables summarization; undefined builds it from config. */
  summarizer?: Summarizer | null;
  exec?: Exec;
  /** Hot-reload the config file (FR-11). Default true. */
  watch?: boolean;
  /** Supervise the global hotkey helper (US-017). Default true. */
  hotkeys?: boolean;
}

export interface RunningDaemon {
  url: string;
  queue: SpeechQueue;
  modes: ModeStore;
  history: History;
  usage: UsageStore;
  stop(): Promise<void>;
}

/** Lets config reloads swap the provider chain under a long-lived speaker. */
class ProviderSwitch implements TtsProvider {
  constructor(public current: TtsProvider) {}
  get name() {
    return this.current.name;
  }
  get maxCharsPerRequest() {
    return this.current.maxCharsPerRequest;
  }
  get pricePerMillionChars() {
    return this.current.pricePerMillionChars;
  }
  synthesize(text: string, opts?: SynthesizeOptions) {
    return this.current.synthesize(text, opts);
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const home = mouthpieceHome(env);
  const log = opts.log ?? jsonLogger;
  const exec = opts.exec ?? defaultExec;
  const cfgPath = configPath(env);
  let config = opts.config ?? (await loadConfig(cfgPath));
  const token = await readOrCreateToken(home);
  const tmpDir = join(home, "tmp");
  const usage = new UsageStore(join(home, "usage.sqlite"));
  const meter = (p: TtsProvider) => new MeteredProvider(p, usage);

  const buildProvider = async (c: Config): Promise<TtsProvider> => {
    if (opts.provider) return meter(opts.provider);
    const inworld = c.provider.chain.includes("inworld")
      ? await resolveSecret("inworld", { env, exec })
      : undefined;
    return createProviderChain(c, {
      env,
      tmpDir,
      log,
      secrets: { inworld },
      wrap: (p) =>
        meter(
          p.pricePerMillionChars > 0
            ? new CachingProvider(p, { dir: join(home, "cache"), maxBytes: c.cache.maxBytes })
            : p,
        ),
    });
  };
  const buildSummarizer = (c: Config) =>
    opts.summarizer === undefined
      ? createSummarizer(c, { home, env })
      : (opts.summarizer ?? undefined);

  const provider = new ProviderSwitch(await buildProvider(config));
  let summarizer = buildSummarizer(config);
  const modes = new ModeStore(config.modes.default, config.profiles);
  const history = new History(config.history);
  const deduper = new AlertDeduper(config.alerts.dedupeWindowMs);
  const preparer = createPreparer({
    resolveMode: (e) => modes.resolve(e),
    settings: () => ({
      summarizer,
      fallback: new FirstSentencesSummarizer(config.summarizer.maxChars),
      thresholdChars: config.summarizer.thresholdChars,
    }),
    log,
  });
  const player = opts.player ?? new AfplayPlayer({ tmpDir });
  const queue = new SpeechQueue({
    play: createSpeaker({
      provider,
      player,
      log,
      prepare: (e) => preparer.prepare(e),
      onSpoken: (r) => history.add(r),
    }),
    expireAfterMs: config.queue.expireAfterMs,
    labelWindowMs: config.queue.labelWindowMs,
    onError: (error, item) =>
      log({ level: "error", msg: "play_failed", id: item.id, error: String(error) }),
  });

  const enqueue = (event: NormalizedSpeakEvent): SpeakResponse => {
    if (event.kind === "response" && modes.resolve(event) === "off") {
      return { id: null, skipped: "muted" };
    }
    if (deduper.isDuplicate(event)) return { id: null, skipped: "duplicate" };
    const reason = skipReason(event, config.filter);
    if (reason) return { id: null, skipped: reason };
    void preparer.prepare(event); // start summarizing now; overlaps whatever is playing
    return { id: queue.enqueue(event).id };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? Number(env.MOUTHPIECE_PORT || DEFAULT_PORT),
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: createHandler({
      token,
      version: VERSION,
      providerName: () => provider.name,
      queueDepth: () => queue.depth,
      enqueue,
      interrupt: (r) => queue.interrupt(r.source, r.conversationId),
      stopAll: () => queue.stopAll(),
      skip: () => ({ skipped: queue.skip() }),
      getMode: () => modes.state(),
      setMode: (r) => modes.apply(r),
      replay: ({ full }) => {
        const last = history.last();
        if (!last) return { id: null };
        const text = full ? last.full : last.spoken;
        return {
          id: queue.enqueue({
            ...last.event,
            text,
            format: "plain",
            mode: "full",
            kind: "response",
          }).id,
        };
      },
      usage: (month) => {
        const now = new Date();
        const range = month ? monthRange(month) : billingCycle(now, config.usage.resetDay);
        return usage.report({
          from: range.start,
          to: range.end,
          quotas: config.usage.quotas,
          resetDay: config.usage.resetDay,
          now,
        });
      },
    }),
  });
  const url = `http://127.0.0.1:${server.port}`;

  let hotkeys: { stop(): void } | undefined;
  const startHotkeys = (c: Config) => {
    hotkeys?.stop();
    hotkeys = undefined;
    if (opts.hotkeys === false || !c.hotkeys.enabled) return;
    const binary = hotkeysBinary(home);
    if (!existsSync(binary)) {
      log({ msg: "hotkeys_unavailable", hint: "run `mouthpiece build-hotkeys`" });
      return;
    }
    try {
      hotkeys = superviseHotkeys({
        binary,
        args: helperArgs(c.hotkeys, { url, tokenPath: tokenPath(home) }),
        log,
      });
    } catch (error) {
      log({ level: "error", msg: "hotkeys_config_invalid", error: String(error) });
    }
  };
  startHotkeys(config);

  const unwatch =
    opts.watch === false
      ? () => {}
      : watchConfig(cfgPath, {
          onChange: async (next) => {
            // Build the new chain before touching any state so a failure keeps the old config.
            const nextProvider = opts.provider ? undefined : await buildProvider(next);
            config = next;
            if (nextProvider) provider.current = nextProvider;
            summarizer = buildSummarizer(next);
            modes.configure(next.modes.default, next.profiles);
            history.configure(next.history);
            deduper.windowMs = next.alerts.dedupeWindowMs;
            startHotkeys(next);
            log({ msg: "config_reloaded", provider: provider.name });
          },
          onError: (error) =>
            log({ level: "warn", msg: "config_reload_failed", error: String(error) }),
        });

  log({ msg: "listening", url, provider: provider.name, version: VERSION });
  return {
    url,
    queue,
    modes,
    history,
    usage,
    stop: async () => {
      unwatch();
      hotkeys?.stop();
      queue.stopAll();
      server.stop(true);
      usage.close();
    },
  };
}
