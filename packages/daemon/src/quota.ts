import type {
  AudioClip,
  Config,
  Logger,
  ProviderUsage,
  QuotaLevel,
  SynthesizeOptions,
  TtsProvider,
  VoiceInfo,
} from "@mouthpiece/core";
import { billingCycle, levelFor, type UsageStore } from "./usage.ts";

/** Notice key for the monthly budget in the `notices` table. */
const BUDGET = "*budget";

/** Spoken provider names that plain title-casing would garble. */
const DISPLAY_NAMES: Record<string, string> = { elevenlabs: "ElevenLabs", openai: "OpenAI" };

export interface QuotaGuardOptions {
  store: Pick<UsageStore, "markNotice" | "usedChars" | "spentUsd">;
  /** Read on every call, so a config hot reload applies immediately. */
  config: () => Config;
  now?: () => Date;
  /** Speaks a notice; called at most once per provider (or budget), level and billing cycle. */
  notify: (text: string) => void;
  log: Logger;
}

/** A provider skipped because its quota, or the monthly budget, is used up (US-016). */
export class QuotaExceededError extends Error {
  constructor(readonly provider: string) {
    super(`${provider}: quota or budget exceeded for this billing cycle`);
    this.name = "QuotaExceededError";
  }
}

/** Quota and budget levels per billing cycle, with persisted one-time notices (US-016). */
export class QuotaGuard {
  readonly #opts: QuotaGuardOptions;
  readonly #now: () => Date;

  constructor(opts: QuotaGuardOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => new Date());
  }

  /**
   * Recomputes `provider`'s quota level and the budget level after a synthesis, and speaks a notice the
   * first time each reaches `warn` or `exceeded` in this cycle. `paid` = false (e.g. `say`) is never
   * blocked, so its "used up" notice does not promise a switch to the system voice.
   */
  afterUse(provider: string, paid = true): void {
    try {
      const { usage } = this.#opts.config();
      const cycle = billingCycle(this.#now(), usage.resetDay);
      const until = formatDay(cycle.end);
      const quota = usage.quotas[provider];
      if (quota) {
        const used = this.#opts.store.usedChars(provider, cycle.start, cycle.end);
        const level = levelFor(used, quota.chars, usage.warnAt);
        const name = displayName(provider);
        this.#notice(provider, cycle.start, level, () =>
          level === "exceeded" && paid
            ? `${name} quota is used up. Using the system voice until ${until}.`
            : `${name} has used ${percent(used, quota.chars)}% of its monthly quota.`,
        );
      }
      const budget = usage.monthlyBudgetUsd;
      if (budget !== undefined) {
        const spent = this.#opts.store.spentUsd(cycle.start, cycle.end);
        const level = levelFor(spent, budget, usage.warnAt);
        this.#notice(BUDGET, cycle.start, level, () =>
          level === "exceeded"
            ? `Mouthpiece's ${dollars(budget)} monthly budget is used up. Using the system voice until ${until}.`
            : `Mouthpiece has used ${percent(spent, budget)}% of its ${dollars(budget)} monthly budget.`,
        );
      }
    } catch (error) {
      this.#opts.log({ level: "error", msg: "quota_check_failed", provider, error: String(error) });
    }
  }

  /**
   * True when a paid provider's quota is exceeded in the current cycle, or when `paid` and the budget is
   * exceeded. Computed live, so a new cycle or a raised limit unblocks it automatically.
   */
  isBlocked(provider: string, paid: boolean): boolean {
    if (!paid) return false;
    const { usage } = this.#opts.config();
    const cycle = billingCycle(this.#now(), usage.resetDay);
    const quota = usage.quotas[provider];
    if (quota) {
      const used = this.#opts.store.usedChars(provider, cycle.start, cycle.end);
      if (levelFor(used, quota.chars, usage.warnAt) === "exceeded") return true;
    }
    const budget = usage.monthlyBudgetUsd;
    if (budget === undefined) return false;
    const spent = this.#opts.store.spentUsd(cycle.start, cycle.end);
    return levelFor(spent, budget, usage.warnAt) === "exceeded";
  }

  #notice(key: string, cycleStart: Date, level: QuotaLevel, text: () => string): void {
    if (level === "ok" || !this.#opts.store.markNotice(key, cycleStart, level)) return;
    const message = text();
    this.#opts.log({ msg: "quota_notice", provider: key, level, text: message });
    this.#opts.notify(message);
  }
}

/** Rejects with `QuotaExceededError` while blocked, so a fallback chain moves on (FR-8, US-016). */
export class QuotaGatedProvider implements TtsProvider {
  readonly listVoices?: () => Promise<VoiceInfo[]>;
  readonly usageStatus?: () => Promise<ProviderUsage | undefined>;

  constructor(
    private readonly inner: TtsProvider,
    private readonly guard: Pick<QuotaGuard, "isBlocked" | "afterUse">,
  ) {
    if (inner.listVoices) this.listVoices = inner.listVoices.bind(inner);
    if (inner.usageStatus) this.usageStatus = inner.usageStatus.bind(inner);
  }

  get name() {
    return this.inner.name;
  }
  get maxCharsPerRequest() {
    return this.inner.maxCharsPerRequest;
  }
  get chunking() {
    return this.inner.chunking;
  }
  get pricePerMillionChars() {
    return this.inner.pricePerMillionChars;
  }
  get cacheKey() {
    return this.inner.cacheKey;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    const paid = this.inner.pricePerMillionChars > 0;
    if (this.guard.isBlocked(this.inner.name, paid)) throw new QuotaExceededError(this.inner.name);
    const clip = await this.inner.synthesize(text, options);
    this.guard.afterUse(this.inner.name, paid);
    return clip;
  }
}

function displayName(provider: string): string {
  return DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Whole percent, rounded down so "100%" is only spoken when the limit is actually reached. */
function percent(used: number, limit: number): number {
  return Math.floor((used * 100) / limit + 1e-9);
}

function dollars(x: number): string {
  return Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`;
}

/** e.g. "Nov 1". */
function formatDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
