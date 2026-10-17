import { parseArgs } from "node:util";
import type { QuotaLevel } from "@mouthpiece/core";
import type { CommandFn } from "../types.ts";

const n = (x: number) => x.toLocaleString("en-US");
const usd = (x: number) => `$${x.toFixed(2)}`;
const MARKERS: Record<QuotaLevel, string> = { ok: "", warn: " [WARN]", exceeded: " [EXCEEDED]" };

/** `mouthpiece usage [--month YYYY-MM]`: rows, quota and budget levels, summarizer stats (US-016). */
export const usageCommand: CommandFn = async (args, io, deps) => {
  const { values } = parseArgs({ args, options: { month: { type: "string" } } });
  const report = await deps.client.usage(values.month ? { month: values.month } : {});
  const header = ["provider", "source", "requests", "chars", "cached", "cost"];
  const rows = report.rows.map((r) => [
    r.provider,
    r.source,
    n(r.requests),
    n(r.chars),
    n(r.cacheHits),
    `$${r.costUsd.toFixed(2)}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  io.out(
    `${report.from.slice(0, 10)} → ${report.to.slice(0, 10)}\n${line(header)}\n${rows.map((r) => `${line(r)}\n`).join("")}`,
  );
  const flagged = (text: string, level: QuotaLevel) => {
    const marker = MARKERS[level];
    const full = `${text}${marker}`;
    io.out(`${full}\n`);
    if (marker) io.err(`warning: ${full}\n`);
  };
  for (const q of report.quotas) {
    const pct = ((q.usedChars / q.limitChars) * 100).toFixed(1);
    flagged(
      `quota ${q.provider}: ${n(q.usedChars)} / ${n(q.limitChars)} chars used (${pct}%), ${n(q.remainingChars)} left, projected ${n(q.projectedChars)} by ${q.cycleEnd.slice(0, 10)}`,
      q.level,
    );
    const pr = q.providerReported;
    if (pr) {
      const resets = pr.resetsAt ? `, resets ${pr.resetsAt.slice(0, 10)}` : "";
      io.out(`  provider reports: ${n(pr.usedChars)} / ${n(pr.limitChars)} chars${resets}\n`);
    }
  }
  const b = report.budget;
  if (b) {
    const pct = ((b.spentUsd / b.limitUsd) * 100).toFixed(1);
    flagged(
      `budget: ${usd(b.spentUsd)} of ${usd(b.limitUsd)} (${pct}%), projected ${usd(b.projectedUsd)}`,
      b.level,
    );
  }
  const s = report.summaries;
  if (s) {
    const median = s.medianMs === null ? "" : `, median ${n(s.medianMs)} ms`;
    io.out(`summaries: ${n(s.calls)} calls, ${n(s.failures)} failed${median}\n`);
  }
  return 0;
};
