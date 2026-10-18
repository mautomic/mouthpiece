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
  type ProviderUsage,
  parseSpeakEvent,
  readOrCreateToken,
  resolveSecret,
  type SpeakResponse,
  type StatusResponse,
  type Summarizer,
  type SynthesizeOptions,
  type TtsProvider,
  tokenPath,
  type VoicesResponse,
} from "@mouthpiece/core";
import {
  helperArgs,
  helperBinary,
  helperWanted,
  type SpawnFn,
  superviseHotkeys,
} from "@mouthpiece/hotkeys";
import {
  chainProviders,
  createProviders,
  type KokoroLoader,
  KokoroProvider,
  PAID_PROVIDERS,
} from "@mouthpiece/providers";
import { createSummarizer, FirstSentencesSummarizer } from "@mouthpiece/summarizers";
import { CachingProvider } from "./cache.ts";
import { AlertDeduper } from "./dedupe.ts";
import { createHandler, MAX_BODY_BYTES } from "./handler.ts";
import { History } from "./history.ts";
import { jsonLogger } from "./log.ts";
import { ModeStore } from "./modes.ts";
import { AfplayPlayer } from "./player.ts";
import { createPreparer } from "./prepare.ts";
import { NOTICE_SOURCE, SpeechQueue } from "./queue.ts";
import { QuotaGatedProvider, QuotaGuard } from "./quota.ts";
import { createSpeaker, skipReason } from "./speaker.ts";
import { billingCycle, MeteredProvider, monthRange, UsageStore } from "./usage.ts";
import { watchConfig } from "./watch.ts";

export const VERSION = "0.4.0";

/** How long `GET /v1/voices` waits for one provider's voice list. The CLI's SLOW_REQUEST_TIMEOUT_MS must exceed it. */
export const VOICES_TIMEOUT_MS = 5_000;
/** How long `GET /v1/usage` waits for one provider's own usage report. The CLI's SLOW_REQUEST_TIMEOUT_MS must exceed it. */
export const PROVIDER_USAGE_TIMEOUT_MS = 3_000;

export interface DaemonOptions {
  env?: Env;
  port?: number;
  config?: Config;
  /** Replaces the whole provider chain (metered only: no voice map, quota gate or cache). */
  provider?: TtsProvider;
  /**
   * Test seam: replaces `createProviders(config)`. The daemon still wraps and chains them as usual
   * (voice map, quota gate, metering, cache for priced providers, fallback).
   */
  providers?: TtsProvider[];
  player?: Player;
  log?: Logger;
  /** null disables summarization; undefined builds it from config. */
  summarizer?: Summarizer | null;
  exec?: Exec;
  /** Hot-reload the config file (FR-11). Default true. */
  watch?: boolean;
  /** Supervise the helper app: hotkeys, menubar, mic pause (US-017, US-018, US-022). Default true. */
  hotkeys?: boolean;
  /** Test seam: how the helper supervisor starts the helper process. */
  helperSpawn?: SpawnFn;
  /** Test seam: replaces `defaultKokoroLoader(home)` when Kokoro is installed under the home. */
  kokoroLoader?: KokoroLoader;
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
  // Assigned once the queue exists; quota notices are only raised while speaking, after startup.
  let notify: (text: string) => void = () => {};
  let noticeSeq = 0;
  const guard = new QuotaGuard({
    store: usage,
    config: () => config,
    notify: (text) => notify(text),
    log,
  });

  /** The configured providers, unwrapped: the voices and provider-usage routes call them directly. */
  const buildProviders = async (c: Config): Promise<TtsProvider[]> => {
    if (opts.provider) return [opts.provider];
    if (opts.providers) return opts.providers;
    const secrets: Record<string, string | undefined> = {};
    for (const name of PAID_PROVIDERS) {
      if (c.provider.chain.includes(name)) secrets[name] = await resolveSecret(name, { env, exec });
    }
    return createProviders(c, { env, tmpDir, log, secrets, home, kokoroLoader: opts.kokoroLoader });
  };
  /** Outermost first: voice map (applied by the chain), quota gate, metering, cache for priced providers. */
  const buildProvider = (c: Config, list: TtsProvider[]): TtsProvider => {
    if (opts.provider) return meter(opts.provider);
    return chainProviders(list, c, {
      log,
      wrap: (p) =>
        new QuotaGatedProvider(
          meter(
            p.pricePerMillionChars > 0
              ? new CachingProvider(p, { dir: join(home, "cache"), maxBytes: c.cache.maxBytes })
              : p,
          ),
          guard,
        ),
    });
  };
  const buildSummarizer = (c: Config) =>
    opts.summarizer === undefined
      ? createSummarizer(c, { home, env })
      : (opts.summarizer ?? undefined);

  let providers = await buildProviders(config);
  const provider = new ProviderSwitch(buildProvider(config, providers));
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
    onSummary: (stat) => usage.recordSummary(stat),
  });
  const player = opts.player ?? new AfplayPlayer({ tmpDir });
  // Replays are not recorded, so history keeps the original full + summary (US-010, FR-7).
  const replays = new WeakSet<NormalizedSpeakEvent>();
  const queue = new SpeechQueue({
    play: createSpeaker({
      provider,
      player,
      log,
      prepare: (e) => preparer.prepare(e),
      onSpoken: (r) => {
        if (!replays.has(r.event)) history.add(r);
      },
    }),
    expireAfterMs: config.queue.expireAfterMs,
    labelWindowMs: config.queue.labelWindowMs,
    maxPauseMs: config.micPause.maxPauseMs,
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
  notify = (text) => {
    // A conversation per notice, so a second notice never replaces a first one still queued.
    const parsed = parseSpeakEvent({
      text,
      source: NOTICE_SOURCE,
      conversationId: `quota-${noticeSeq++}`,
      kind: "alert",
      format: "plain",
    });
    if (parsed.ok) enqueue(parsed.value);
  };

  const voices = async (name: string | undefined): Promise<VoicesResponse> => {
    const list = name === undefined ? providers : providers.filter((p) => p.name === name);
    if (name !== undefined && list.length === 0) {
      return {
        providers: [{ provider: name, voices: [], error: "not in the active provider chain" }],
      };
    }
    return {
      providers: await Promise.all(
        list.map(async (p) => {
          try {
            const voices = p.listVoices
              ? await withTimeout(p.listVoices(), VOICES_TIMEOUT_MS, p.name)
              : [];
            return { provider: p.name, voices };
          } catch (error) {
            return {
              provider: p.name,
              voices: [],
              error: (error as Error).message ?? String(error),
            };
          }
        }),
      ),
    };
  };

  const providerUsage = async (): Promise<Record<string, ProviderUsage>> => {
    const out: Record<string, ProviderUsage> = {};
    await Promise.all(
      providers
        .filter((p) => p.pricePerMillionChars > 0 && p.usageStatus)
        .map(async (p) => {
          try {
            const reported = await withTimeout(
              p.usageStatus?.() ?? Promise.resolve(undefined),
              PROVIDER_USAGE_TIMEOUT_MS,
              p.name,
            );
            if (reported) out[p.name] = reported;
          } catch (error) {
            log({
              level: "warn",
              msg: "provider_usage_failed",
              provider: p.name,
              error: String(error),
            });
          }
        }),
    );
    return out;
  };

  const status = (): StatusResponse => {
    // Read the pause state first: it expires stale reasons, which can resume playback.
    const pauseReasons = queue.pauseReasons();
    const item = queue.current ?? queue.held;
    return {
      version: VERSION,
      speaking: queue.speaking,
      paused: pauseReasons.length > 0,
      pauseReasons,
      mode: modes.state().default,
      queueDepth: queue.depth,
      provider: providers[0]?.name ?? provider.name,
      current: item
        ? {
            source: item.event.source,
            ...(item.event.label !== undefined && { label: item.event.label }),
          }
        : null,
    };
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
        const event: NormalizedSpeakEvent = {
          ...last.event,
          text: full ? last.full : last.spoken,
          format: "plain",
          mode: "full",
          kind: "response",
        };
        replays.add(event);
        return { id: queue.enqueue(event).id };
      },
      usage: async (month) => {
        const now = new Date();
        // Validate the month before any provider round trip.
        const range = month ? monthRange(month) : billingCycle(now, config.usage.resetDay);
        return usage.report({
          from: range.start,
          to: range.end,
          quotas: config.usage.quotas,
          resetDay: config.usage.resetDay,
          now,
          warnAt: config.usage.warnAt,
          monthlyBudgetUsd: config.usage.monthlyBudgetUsd,
          providerUsage: await providerUsage(),
        });
      },
      voices,
      status,
      pause: (reason) => queue.pause(reason),
      resume: (reason) => queue.resume(reason),
    }),
  });
  const url = `http://127.0.0.1:${server.port}`;

  // The helper app (hotkeys, menubar, mic watcher) is one supervised process (US-017/018/022).
  let helper: { stop(): void } | undefined;
  /** A helper that is gone can no longer resume the `mic` pause it reported (US-022). */
  const stopHelper = () => {
    if (!helper) return;
    helper.stop();
    helper = undefined;
    queue.resume("mic");
  };
  const startHelper = (c: Config) => {
    stopHelper();
    if (opts.hotkeys === false || !helperWanted(c)) return;
    const binary = helperBinary(home);
    if (!existsSync(binary)) {
      log({ msg: "helper_unavailable", hint: "run `mouthpiece build-helper`" });
      return;
    }
    try {
      helper = superviseHotkeys({
        binary,
        args: helperArgs(c, { url, tokenPath: tokenPath(home) }),
        log,
        spawn: opts.helperSpawn,
        onExit: () => queue.resume("mic"),
      });
    } catch (error) {
      log({ level: "error", msg: "helper_config_invalid", error: String(error) });
    }
  };
  startHelper(config);

  /** US-019: load Kokoro in the background so the first item doesn't pay for it. */
  const warmUp = (list: TtsProvider[]) => {
    for (const p of list) {
      if (p.name === "kokoro" && p instanceof KokoroProvider) void p.warmUp();
    }
  };
  warmUp(providers);

  const unwatch =
    opts.watch === false
      ? () => {}
      : watchConfig(cfgPath, {
          onChange: async (next) => {
            // Build the new chain before touching any state so a failure keeps the old config.
            const nextProviders = await buildProviders(next);
            const nextProvider = buildProvider(next, nextProviders);
            config = next;
            providers = nextProviders;
            provider.current = nextProvider;
            summarizer = buildSummarizer(next);
            modes.configure(next.modes.default, next.profiles);
            history.configure(next.history);
            deduper.windowMs = next.alerts.dedupeWindowMs;
            queue.configure({ ...next.queue, maxPauseMs: next.micPause.maxPauseMs });
            startHelper(next);
            warmUp(nextProviders);
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
      stopHelper();
      queue.stopAll();
      server.stop(true);
      usage.close();
    },
  };
}

/** Rejects after `ms` (the underlying call is abandoned, not aborted). */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
