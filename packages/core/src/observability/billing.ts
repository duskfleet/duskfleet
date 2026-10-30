/**
 * What a sum of `cost_usd` means. Claude Code reports `total_cost_usd` on every run, also on a
 * subscription, where it is the API value of the usage, not money paid. Only a run that got an
 * API key (`billing_type = 'api'`) is billed; a run without a recorded billing type (from before
 * the column) counts as API value, so no aggregate claims money it cannot prove was spent.
 * The wording follows the runs in view, never a setting: web, CLI and MCP share these labels.
 */

/** Costs of the runs in view, split by billing type. */
export interface CostSplit {
  /** Billed: runs started with an API key. */
  apiUsd: number;
  /** API value of subscription runs (and of runs with no recorded billing type). */
  subscriptionUsd: number;
}

export type CostBasis = "api" | "subscription" | "mixed";

export interface CostLabels {
  basis: CostBasis;
  /** Tile and section title: "Spent", "Usage (API value)", "Spent and usage". */
  heading: string;
  /** One line under the amount; null when the heading says it all. */
  note: string | null;
  /** Table column / per-run stat: "Cost", "API value", "Cost / API value". */
  column: string;
  /** Budget and daily-cap wording: "spent" or "used at API value". */
  verb: string;
}

export const SUBSCRIPTION_NOTE = "included in your Claude subscription";

/** Zero on both sides keeps the plain "Spent": there is nothing to mislabel. */
export function costBasis(split: CostSplit): CostBasis {
  if (split.subscriptionUsd > 0 && split.apiUsd > 0) return "mixed";
  return split.subscriptionUsd > 0 ? "subscription" : "api";
}

export function costLabels(split: CostSplit): CostLabels {
  const basis = costBasis(split);
  if (basis === "subscription")
    return {
      basis,
      heading: "Usage (API value)",
      note: SUBSCRIPTION_NOTE,
      column: "API value",
      verb: "used at API value",
    };
  if (basis === "mixed")
    return {
      basis,
      heading: "Spent and usage",
      note: `billed on an API key, apart from the API value ${SUBSCRIPTION_NOTE}`,
      column: "Cost / API value",
      verb: "spent or used at API value",
    };
  return { basis, heading: "Spent", note: null, column: "Cost", verb: "spent" };
}

/** What one run's `costUsd` is: "Cost" when billed on an API key, "API value" otherwise (same rule as the sums). */
export function runCostLabel(billingType: string | null | undefined): string {
  return billingType === "api" ? "Cost" : "API value";
}

/** A cost sum of the runs in view, split by billing type, with its wording (CLI `runs`, MCP `list_runs`). */
export interface CostTotals extends CostSplit, CostLabels {
  runs: number;
}

const roundUsd = (n: number) => Math.round(n * 10_000) / 10_000;

export function costTotals(runs: readonly { costUsd: number | null; billingType: string | null }[]): CostTotals {
  const split: CostSplit = { apiUsd: 0, subscriptionUsd: 0 };
  for (const r of runs) {
    if (r.billingType === "api") split.apiUsd += r.costUsd ?? 0;
    else split.subscriptionUsd += r.costUsd ?? 0;
  }
  split.apiUsd = roundUsd(split.apiUsd);
  split.subscriptionUsd = roundUsd(split.subscriptionUsd);
  return { runs: runs.length, ...split, ...costLabels(split) };
}

/** One human line for a terminal: "Usage (API value): $3.2 over 5 runs, included in your Claude subscription". */
export function costTotalsLine(t: CostTotals): string {
  const amount =
    t.basis === "mixed"
      ? `$${t.apiUsd} billed, $${t.subscriptionUsd} API value`
      : `$${t.basis === "api" ? t.apiUsd : t.subscriptionUsd}`;
  const runs = `${t.runs} run${t.runs === 1 ? "" : "s"}`;
  return `${t.heading}: ${amount} over ${runs}${t.basis === "subscription" ? `, ${SUBSCRIPTION_NOTE}` : ""}`;
}
