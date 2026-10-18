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
  resolveConfig,
  resolveSecret,
  type SettingsUpdate,
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
  playerBinary,
  type SpawnFn,
  superviseHotkeys,
} from "@mouthpiece/hotkeys";
import {
  chainProviders,
  createProviders,
  type KokoroLoader,
  KokoroProvider,
  PAID_PROVIDERS,
  processKokoroLoader,
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
import { type SaveResult, saveSettings, settingsOf } from "./settings.ts";
import { createSpeaker, skipReason } from "./speaker.ts";
import { createPlayer } from "./stream-player.ts";
import { billingCycle, MeteredProvider, monthRange, UsageStore } from "./usage.ts";
import { watchConfig } from "./watch.ts";

export const VERSION = "0.4.0";

/** How long `GET /v1/voices` waits for one provider's voice list. The CLI's SLOW_REQUEST_TIMEOUT_MS must exceed it. */
export const VOICES_TIMEOUT_MS = 5_000;
/** How long `GET /v1/usage` waits for one provider's own usage report. The CLI's SLOW_REQUEST_TIMEOUT_MS must exceed it. */
export const PROVIDER_USAGE_TIMEOUT_MS = 3_000;

export interface DaemonOptions {
  /**
   * Runs after POST /v1/shutdown has stopped the daemon; the CLI exits the process cleanly, so
   * launchd (which only restarts it after a crash) leaves it stopped.
   */
  onShutdown?: () => void;
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
  /**
   * Test seam: replaces `processKokoroLoader(home)` when Kokoro is installed under the home. Its
   * `terminate()`, when present, runs on stop and when a reload drops Kokoro from the chain.
   */
  kokoroLoader?: KokoroLoader & { terminate?(): void | Promise<void> };
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
  get chunking() {
    return this.current.chunking;
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
  // A bad file must not keep the daemon from starting: run on the defaults and report it.
  let configError: string | undefined;
  let config: Config;
  try {
    config = opts.config ?? (await loadConfig(cfgPath));
  } catch (error) {
    configError = errorMessage(error);
    log({ level: "warn", msg: "config_load_failed", error: configError });
    config = resolveConfig({});
  }
  const token = await readOrCreateToken(home);
  const tmpDir = join(home, "tmp");
  const usage = new UsageStore(join(home, "usage.sqlite"));
  const meter = (p: TtsProvider) => new MeteredProvider(p, usage);
  // Assigned once the queue exists; quota notices are only raised while speaking, after startup.
  let notify: (text: string) => void = () => {};
  let noticeSeq = 0;
  // One Kokoro host process at a time, shared by every chain a reload builds. It starts on first
  // use, so a chain without Kokoro never spawns it.
  const kokoroLoader = opts.kokoroLoader ?? processKokoroLoader(home, { log });
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
    return createProviders(c, { env, tmpDir, log, secrets, home, kokoroLoader });
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
  // US-005: gap-free playback through mouthpiece-player when it's built; afplay plays the rest.
  const players = opts.player
    ? { player: opts.player, name: "custom", stop: async () => {} }
    : createPlayer({
        backend: config.player.backend,
        binary: playerBinary(home),
        fallback: new AfplayPlayer({ tmpDir }),
        log,
      });
  const player = players.player;
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
      conversationId: `notice-${noticeSeq++}`,
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
      ...(configError !== undefined && { configError }),
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
      settings: () => settingsOf(config),
      shutdown: () => {
        log({ msg: "shutdown_requested" });
        // After this reply has gone out.
        setTimeout(() => void running.stop().finally(() => opts.onShutdown?.()), 50);
        return { stopping: true };
      },
      updateSettings: (update) => updateSettings(update),
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
  /** What the running helper was started from; a reload restarts it only when this changes. */
  let helperKey: string | undefined;
  const startHelper = (c: Config) => {
    const wanted = opts.hotkeys !== false && helperWanted(c);
    const binary = helperBinary(home);
    const built = wanted && existsSync(binary);
    let args: string[] | undefined;
    let argsError: string | undefined;
    if (built) {
      try {
        args = helperArgs(c, { url, tokenPath: tokenPath(home) });
      } catch (error) {
        argsError = String(error);
      }
    }
    // An unrelated config edit must not restart the helper: stopping it clears the mic pause.
    const key = JSON.stringify({ wanted, binary, built, args, argsError });
    if (key === helperKey) return;
    helperKey = key;
    stopHelper();
    if (!wanted) return;
    if (!built) {
      log({ msg: "helper_unavailable", hint: "run `mouthpiece build-helper`" });
      return;
    }
    if (!args) {
      log({ level: "error", msg: "helper_config_invalid", error: argsError });
      return;
    }
    try {
      helper = superviseHotkeys({
        binary,
        args,
        log,
        spawn: opts.helperSpawn,
        onExit: () => queue.resume("mic"),
      });
    } catch (error) {
      helperKey = undefined; // retry on the next reload
      log({ level: "error", msg: "helper_start_failed", error: String(error) });
    }
  };
  startHelper(config);

  /**
   * US-019: load Kokoro in the background so the first item doesn't pay for it. A chain without
   * Kokoro kills its host process (and frees the model), even mid-render; the next use starts a
   * new one.
   */
  const warmUp = (list: TtsProvider[]) => {
    const kokoro = list.filter((p) => p instanceof KokoroProvider);
    for (const p of kokoro) void p.warmUp();
    if (kokoro.length === 0) void kokoroLoader.terminate?.();
  };
  warmUp(providers);

  /**
   * Makes `next` the running config (FR-11). A config equal to the running one changes nothing (a
   * settings change is applied at once, then the watcher sees the same file); a throw keeps the old
   * config.
   */
  const applyConfig = async (next: Config) => {
    if (JSON.stringify(next) === JSON.stringify(config)) {
      configError = undefined;
      return;
    }
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
    configError = undefined;
    log({ msg: "config_reloaded", provider: provider.name });
  };

  // One settings change at a time: each reads the file the previous one wrote.
  let settingsQueue: Promise<unknown> = Promise.resolve();
  const updateSettings = (update: SettingsUpdate): Promise<SaveResult> => {
    const run = settingsQueue.then(async (): Promise<SaveResult> => {
      const saved = await saveSettings(cfgPath, update);
      if (saved.ok) await applyConfig(saved.config);
      return saved;
    });
    settingsQueue = run.catch(() => {});
    return run;
  };

  const unwatch =
    opts.watch === false
      ? () => {}
      : watchConfig(cfgPath, {
          onChange: applyConfig,
          onError: (error) => {
            configError = errorMessage(error);
            log({ level: "warn", msg: "config_reload_failed", error: String(error) });
            notify(configNotice("keeping the previous settings"));
          },
        });
  if (configError !== undefined) notify(configNotice("using the default settings"));

  log({ msg: "listening", url, provider: provider.name, player: players.name, version: VERSION });
  // Stopping twice (a Quit, then the process exiting) is safe: the second call waits on the first.
  let stopping: Promise<void> | undefined;
  const running: RunningDaemon = {
    url,
    queue,
    modes,
    history,
    usage,
    stop: () =>
      (stopping ??= (async () => {
        unwatch();
        stopHelper();
        queue.stopAll();
        await players.stop();
        server.stop(true);
        // Kills the Kokoro host (safe mid-render) and waits briefly for it to exit.
        await kokoroLoader.terminate?.();
        usage.close();
      })()),
  };
  return running;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configNotice(outcome: string): string {
  return `Mouthpiece couldn't read its config file, so it's ${outcome}. Run mouthpiece status to see why.`;
}

/** Rejects after `ms` (the underlying call is abandoned, not aborted). */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
