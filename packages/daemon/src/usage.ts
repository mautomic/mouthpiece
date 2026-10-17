import { Database } from "bun:sqlite";
import {
  type AudioClip,
  type Config,
  DEFAULT_CONFIG,
  type ProviderUsage,
  type QuotaLevel,
  type QuotaStatus,
  type SynthesizeOptions,
  type TtsProvider,
  type UsageReport,
  type UsageRow,
} from "@mouthpiece/core";

export interface UsageRecord {
  provider: string;
  source: string;
  chars: number;
  cached: boolean;
  costUsd: number;
}

export interface SummaryRecord {
  backend: string;
  ms: number;
  charsIn: number;
  charsOut: number;
  ok: boolean;
}

export interface UsageReportOptions {
  from: Date;
  to: Date;
  quotas: Config["usage"]["quotas"];
  resetDay: number;
  now: Date;
  /** Fraction of a quota or budget at which the level becomes `warn`. Default: `DEFAULT_CONFIG.usage.warnAt`. */
  warnAt?: number;
  /** Adds `budget` for the current billing cycle. */
  monthlyBudgetUsd?: number;
  /** Provider-reported usage, attached to the matching configured quota. */
  providerUsage?: Record<string, ProviderUsage>;
}

/** `ok` below `warnAt` of `limit`, `warn` at or above it, `exceeded` at or above 100%. */
export function levelFor(used: number, limit: number, warnAt: number): QuotaLevel {
  if (used >= limit) return "exceeded";
  return used / limit >= warnAt ? "warn" : "ok";
}

export function billingCycle(now: Date, resetDay: number): { start: Date; end: Date } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = now.getDate() >= resetDay ? new Date(y, m, resetDay) : new Date(y, m - 1, resetDay);
  return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, resetDay) };
}

export function monthRange(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new Error("month must be YYYY-MM");
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
}

/** Per-synthesis metering in SQLite (US-016 core, FR-10). */
export class UsageStore {
  readonly #db: Database;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.#db = new Database(path, { create: true });
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS synth (ts INTEGER NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL, chars INTEGER NOT NULL, cached INTEGER NOT NULL, cost_usd REAL NOT NULL)",
    );
    this.#db.run("CREATE INDEX IF NOT EXISTS synth_ts ON synth(ts)");
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS notices (provider TEXT NOT NULL, cycle_start INTEGER NOT NULL, level TEXT NOT NULL, PRIMARY KEY (provider, cycle_start, level))",
    );
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS summaries (ts INTEGER NOT NULL, backend TEXT NOT NULL, ms INTEGER NOT NULL, chars_in INTEGER NOT NULL, chars_out INTEGER NOT NULL, ok INTEGER NOT NULL)",
    );
    this.#db.run("CREATE INDEX IF NOT EXISTS summaries_ts ON summaries(ts)");
  }

  record(r: UsageRecord): void {
    this.#db
      .query(
        "INSERT INTO synth (ts, provider, source, chars, cached, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(this.now(), r.provider, r.source, r.chars, r.cached ? 1 : 0, r.costUsd);
  }

  recordSummary(r: SummaryRecord): void {
    this.#db
      .query(
        "INSERT INTO summaries (ts, backend, ms, chars_in, chars_out, ok) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(this.now(), r.backend, Math.round(r.ms), r.charsIn, r.charsOut, r.ok ? 1 : 0);
  }

  /** Records that a notice was given; true only the first time for this provider, cycle and level. */
  markNotice(provider: string, cycleStart: Date, level: QuotaLevel): boolean {
    const result = this.#db
      .query("INSERT OR IGNORE INTO notices (provider, cycle_start, level) VALUES (?, ?, ?)")
      .run(provider, cycleStart.getTime(), level);
    return result.changes > 0;
  }

  /** Billed characters (cache hits excluded) for one provider in [from, to). */
  usedChars(provider: string, from: Date, to: Date): number {
    const row = this.#db
      .query(
        "SELECT SUM(chars) AS used FROM synth WHERE provider = ? AND cached = 0 AND ts >= ? AND ts < ?",
      )
      .get(provider, from.getTime(), to.getTime()) as { used: number | null };
    return row.used ?? 0;
  }

  /** Estimated cost across all providers in [from, to). */
  spentUsd(from: Date, to: Date): number {
    const row = this.#db
      .query("SELECT SUM(cost_usd) AS spent FROM synth WHERE ts >= ? AND ts < ?")
      .get(from.getTime(), to.getTime()) as { spent: number | null };
    return row.spent ?? 0;
  }

  report(opts: UsageReportOptions): UsageReport {
    const warnAt = opts.warnAt ?? DEFAULT_CONFIG.usage.warnAt;
    const rows = this.#db
      .query(
        `SELECT provider, source, COUNT(*) AS requests,
                SUM(CASE WHEN cached = 1 THEN 0 ELSE chars END) AS chars,
                SUM(cached) AS cacheHits, ROUND(SUM(cost_usd), 6) AS costUsd
         FROM synth WHERE ts >= ? AND ts < ? GROUP BY provider, source ORDER BY provider, source`,
      )
      .all(opts.from.getTime(), opts.to.getTime()) as UsageRow[];
    const cycle = billingCycle(opts.now, opts.resetDay);
    const day = 86_400_000;
    const elapsedDays = Math.max(1, (opts.now.getTime() - cycle.start.getTime()) / day);
    const cycleDays = (cycle.end.getTime() - cycle.start.getTime()) / day;
    const project = (x: number) => (x / elapsedDays) * cycleDays;
    const quotas = Object.entries(opts.quotas).map(([provider, { chars: limitChars }]) => {
      const used = this.usedChars(provider, cycle.start, cycle.end);
      const status: QuotaStatus = {
        provider,
        limitChars,
        usedChars: used,
        remainingChars: Math.max(0, limitChars - used),
        projectedChars: Math.round(project(used)),
        cycleStart: cycle.start.toISOString(),
        cycleEnd: cycle.end.toISOString(),
        level: levelFor(used, limitChars, warnAt),
      };
      const reported = opts.providerUsage?.[provider];
      if (reported) status.providerReported = reported;
      return status;
    });
    const report: UsageReport = {
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      rows,
      quotas,
    };
    if (opts.monthlyBudgetUsd !== undefined) {
      const spent = this.spentUsd(cycle.start, cycle.end);
      report.budget = {
        limitUsd: opts.monthlyBudgetUsd,
        spentUsd: round6(spent),
        projectedUsd: round6(project(spent)),
        level: levelFor(spent, opts.monthlyBudgetUsd, warnAt),
      };
    }
    report.summaries = this.#summaryStats(opts.from, opts.to);
    return report;
  }

  #summaryStats(from: Date, to: Date): NonNullable<UsageReport["summaries"]> {
    const rows = this.#db
      .query("SELECT ms, ok FROM summaries WHERE ts >= ? AND ts < ? ORDER BY ms")
      .all(from.getTime(), to.getTime()) as { ms: number; ok: number }[];
    return {
      calls: rows.length,
      failures: rows.filter((r) => r.ok === 0).length,
      medianMs: median(rows.map((r) => r.ms)),
    };
  }

  close(): void {
    this.#db.close();
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The median of an ascending list (the mean of the middle two, rounded, when even); null when empty. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** Records one usage row per synthesis; cache hits are free (FR-10). */
export class MeteredProvider implements TtsProvider {
  constructor(
    private readonly inner: TtsProvider,
    private readonly store: Pick<UsageStore, "record">,
  ) {}

  get name() {
    return this.inner.name;
  }
  get maxCharsPerRequest() {
    return this.inner.maxCharsPerRequest;
  }
  get pricePerMillionChars() {
    return this.inner.pricePerMillionChars;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    const clip = await this.inner.synthesize(text, options);
    const cached = clip.cached ?? false;
    this.store.record({
      provider: this.inner.name,
      source: options.tag ?? "unknown",
      chars: text.length,
      cached,
      costUsd: cached ? 0 : (text.length * this.inner.pricePerMillionChars) / 1_000_000,
    });
    return clip;
  }
}
