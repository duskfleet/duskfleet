/**
 * Pure helpers of the /costs page: the dollar axis, short amounts and the budget scaled to a
 * bucket. No data access (lib/data.ts) and no JSX, so test/costs.test.mjs runs them as is.
 */
import type { CostSplitBy, TrendBucket } from "@duskfleet/core";

export const SPLIT_LABELS: Record<CostSplitBy, string> = {
  agent: "By agent",
  project: "By project",
  model: "By model",
};

/** "agents", "projects", "models": the legend's "other agents (one segment each)". */
export const SPLIT_PLURALS: Record<CostSplitBy, string> = {
  agent: "agents",
  project: "projects",
  model: "models",
};

/** The noun of a table row: "agent", "project", "model". */
export const SPLIT_NOUNS: Record<CostSplitBy, string> = {
  agent: "agent",
  project: "project",
  model: "model",
};

/** Rows ticked when the URL names none for the split. */
export const DEFAULT_TICKED = 5;

/** "$9.84", "$0.32", "$34.10": the amounts of the ranked table, always two decimals. */
export function fmtUsd2(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** One row of the ranked table: an agent, a project path or a model of the period. */
export interface CostRow {
  key: string;
  /** Spend of real runs in the period. */
  spent: number;
  /** Finished real runs in the period. */
  runs: number;
  /** Share of the period total, 0..1 (0 when nothing was spent). */
  share: number;
  /** spent / runs; null without a finished run. */
  avg: number | null;
}

/**
 * Every key of the period, spent or merely run, ranked by spend (then runs, then key): the
 * split's spend series joined with its finished-run counts.
 */
export function costRows(
  series: ReadonlyArray<{ key: string; total: number }>,
  runs: ReadonlyMap<string, number>,
): CostRow[] {
  const spent = new Map(series.map((s) => [s.key, s.total]));
  const keys = new Set([...spent.keys(), ...[...runs].filter(([, n]) => n > 0).map(([k]) => k)]);
  const total = series.reduce((n, s) => n + s.total, 0);
  return [...keys]
    .map((key) => {
      const usd = spent.get(key) ?? 0;
      const n = runs.get(key) ?? 0;
      return { key, spent: usd, runs: n, share: total > 0 ? usd / total : 0, avg: n > 0 ? usd / n : null };
    })
    .sort((a, b) => b.spent - a.spent || b.runs - a.runs || a.key.localeCompare(b.key));
}

/**
 * The ticked keys, in rank order. `param` is the split's URL values, null when the URL has none
 * (then the top DEFAULT_TICKED spenders); an explicitly empty param (`?agent=`) ticks nothing.
 * Unknown keys are dropped.
 */
export function resolveTicks(param: ReadonlyArray<string> | null, rows: ReadonlyArray<CostRow>): string[] {
  if (param === null) {
    return rows
      .filter((r) => r.spent > 0)
      .slice(0, DEFAULT_TICKED)
      .map((r) => r.key);
  }
  const wanted = new Set(param);
  return rows.filter((r) => wanted.has(r.key)).map((r) => r.key);
}

/**
 * The URL values after toggling `key`, in rank order. Nothing left is `[""]` (`?agent=`), so the
 * empty set survives a reload instead of falling back to the default.
 */
export function toggleTick(ticked: ReadonlyArray<string>, key: string, rows: ReadonlyArray<CostRow>): string[] {
  const next = new Set(ticked);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  const out = rows.filter((r) => next.has(r.key)).map((r) => r.key);
  return out.length ? out : [""];
}

export type CostTone = "accent" | "faint" | "others";

export interface CostStack {
  key: string;
  tone: CostTone;
  values: number[];
  /** The table row it draws; null for "others" and the nothing-ticked total. */
  row: string | null;
}

/**
 * The bars' segments, bottom to top: one per ticked row in rank order (the first in the accent,
 * the rest faint), then the unticked rows folded into "others". Nothing ticked: one faint
 * segment, the total.
 */
export function costStacks(
  series: ReadonlyArray<{ key: string; values: ReadonlyArray<number> }>,
  totals: ReadonlyArray<number>,
  ticked: ReadonlyArray<string>,
): CostStack[] {
  if (ticked.length === 0) return [{ key: "__total", tone: "faint", values: [...totals], row: null }];
  const byKey = new Map(series.map((s) => [s.key, s.values]));
  const drawn = ticked.map((key, i) => ({
    key,
    tone: (i === 0 ? "accent" : "faint") as CostTone,
    values: totals.map((_, b) => byKey.get(key)?.[b] ?? 0),
    row: key,
  }));
  const others = totals.map((t, b) => Math.max(0, t - drawn.reduce((n, d) => n + (d.values[b] ?? 0), 0)));
  return others.some((v) => v > 1e-9)
    ? [...drawn, { key: "__others", tone: "others", values: others, row: null }]
    : drawn;
}

/** "2.7×": how many average runs one run of the top spender costs, one decimal. */
export function timesText(avg: number, overall: number): string | null {
  if (!(overall > 0)) return null;
  return `${Number((avg / overall).toFixed(1))}×`;
}

/** "$0", "$0.42", "$3.5", "$38": a bar total or an axis tick, as short as it stays readable. */
export function fmtUsdShort(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 10) return `$${Math.round(usd)}`;
  if (usd >= 1) return `$${Number(usd.toFixed(1))}`;
  return `$${Number(usd.toFixed(2))}`;
}

/** A dollar axis from 0 to a round maximum with about three steps: $0 $20 $40 $60, or $0 $0.05 $0.10. */
export function moneyAxis(maxValue: number): { max: number; ticks: number[] } {
  const target = (maxValue > 0 ? maxValue : 1) / 3;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= target) ?? magnitude * 10;
  const steps = Math.max(1, Math.ceil(maxValue / step - 1e-9));
  // whole multiples, rounded so 0.1 + 0.2 does not print as 0.30000000000000004
  const ticks = Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { max: ticks.at(-1) as number, ticks };
}

/**
 * A monthly budget drawn against a bucket of spend: the whole amount for a month, its share of
 * an average month (365 / 12 days) for a day or an ISO week. Bars of weeks against $50 would
 * never come near the line; pro rata keeps the line where overspending starts.
 */
export function budgetPerBucket(monthlyUsd: number, bucket: TrendBucket): number {
  if (bucket === "month") return monthlyUsd;
  const days = bucket === "week" ? 7 : 1;
  return (monthlyUsd * 12 * days) / 365;
}
