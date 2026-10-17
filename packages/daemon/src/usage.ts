import { Database } from "bun:sqlite";
import type {
  AudioClip,
  Config,
  SynthesizeOptions,
  TtsProvider,
  UsageReport,
  UsageRow,
} from "@mouthpiece/core";

export interface UsageRecord {
  provider: string;
  source: string;
  chars: number;
  cached: boolean;
  costUsd: number;
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
  }

  record(r: UsageRecord): void {
    this.#db
      .query(
        "INSERT INTO synth (ts, provider, source, chars, cached, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(this.now(), r.provider, r.source, r.chars, r.cached ? 1 : 0, r.costUsd);
  }

  report(opts: {
    from: Date;
    to: Date;
    quotas: Config["usage"]["quotas"];
    resetDay: number;
    now: Date;
  }): UsageReport {
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
    const usedQuery = this.#db.query(
      "SELECT SUM(chars) AS used FROM synth WHERE provider = ? AND cached = 0 AND ts >= ? AND ts < ?",
    );
    const quotas = Object.entries(opts.quotas).map(([provider, { chars: limitChars }]) => {
      const row = usedQuery.get(provider, cycle.start.getTime(), cycle.end.getTime()) as {
        used: number | null;
      };
      const used = row.used ?? 0;
      return {
        provider,
        limitChars,
        usedChars: used,
        remainingChars: Math.max(0, limitChars - used),
        projectedChars: Math.round((used / elapsedDays) * cycleDays),
        cycleStart: cycle.start.toISOString(),
        cycleEnd: cycle.end.toISOString(),
      };
    });
    return { from: opts.from.toISOString(), to: opts.to.toISOString(), rows, quotas };
  }

  close(): void {
    this.#db.close();
  }
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
