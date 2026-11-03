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
