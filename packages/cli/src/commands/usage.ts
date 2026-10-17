import { parseArgs } from "node:util";
import type { CommandFn } from "../types.ts";

const n = (x: number) => x.toLocaleString("en-US");

/** `mouthpiece usage [--month YYYY-MM]` (US-016 core). */
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
  for (const q of report.quotas) {
    const pct = ((q.usedChars / q.limitChars) * 100).toFixed(1);
    io.out(
      `quota ${q.provider}: ${n(q.usedChars)} / ${n(q.limitChars)} chars used (${pct}%), ${n(q.remainingChars)} left, projected ${n(q.projectedChars)} by ${q.cycleEnd.slice(0, 10)}\n`,
    );
  }
  return 0;
};
