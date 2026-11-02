/**
 * Spend over time, for the dashboard's /costs page: the recorded `cost_usd` per UTC bucket of a
 * trend range (same buckets as /trends), split by agent, project or model. Gate runs are spend
 * too (budgets count them) but never mixed into the split: they are a series of their own.
 * Runs are bucketed by created_at, the instant budgets count a run's spend from.
 */

import type { DatabaseSync } from "node:sqlite";
import { MIXED_MODEL } from "../execution/types.js";
import { type TrendBucket, type TrendRange, trendBuckets } from "./trends.js";

export const COST_SPLITS = ["agent", "project", "model"] as const;
export type CostSplitBy = (typeof COST_SPLITS)[number];

// project: the path, as the runs record it; the dashboard names it from the registry.
// model: the model actually used, a mixed run under the one it asked for (as the By model table).
const KEY_SQL: Record<CostSplitBy, string> = {
  agent: "agent_id",
  project: "project_path",
  model: `COALESCE(NULLIF(model_used, '${MIXED_MODEL}'), model_requested, 'default')`,
};

const BUCKET_SQL: Record<TrendBucket, string> = {
  day: "date(created_at)",
  week: "date(created_at, 'weekday 0', '-6 days')",
  month: "date(created_at, 'start of month')",
};

export interface CostSeriesFilter {
  range: TrendRange;
  by: CostSplitBy;
  agentId?: string;
  projectPath?: string;
  /** Defaults to the current time; tests pin it. */
  now?: Date;
}

export interface CostSeries {
  range: TrendRange;
  bucket: TrendBucket;
  by: CostSplitBy;
  /** Bucket start dates, UTC, oldest first; every array below is aligned with it. */
  starts: string[];
  /** Spend of real runs per key with any spend in the period, biggest spender first. */
  series: Array<{ key: string; values: number[]; total: number }>;
  /** Spend of real runs per bucket (the sum of `series`). */
  totals: number[];
  /** Spend of gate runs per bucket, never part of `series`. */
  gates: number[];
  /** Real runs started per bucket. */
  runs: number[];
  /** Sums over the period. */
  total: number;
  gateTotal: number;
  runCount: number;
}

export function costSeries(db: DatabaseSync, filter: CostSeriesFilter): CostSeries {
  const { bucket, starts, from, end } = trendBuckets(filter.range, filter.now ?? new Date());
  const where = ["created_at >= ?", "created_at < ?"];
  const values: string[] = [from, end];
  if (filter.agentId) {
    where.push("agent_id = ?");
    values.push(filter.agentId);
  }
  if (filter.projectPath) {
    where.push("project_path = ?");
    values.push(filter.projectPath);
  }
  const rows = db
    .prepare(
      `SELECT kind, ${KEY_SQL[filter.by]} AS k, ${BUCKET_SQL[bucket]} AS b,
              COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS n
       FROM runs WHERE ${where.join(" AND ")}
       GROUP BY kind, k, b`,
    )
    .all(...values) as Array<{ kind: string; k: string | null; b: string; cost: number; n: number }>;

  const index = new Map(starts.map((s, i) => [s, i]));
  const zeros = () => starts.map(() => 0);
  const totals = zeros();
  const gates = zeros();
  const runs = zeros();
  const keys = new Map<string, number[]>();
  for (const r of rows) {
    const i = index.get(r.b);
    if (i === undefined) continue;
    if (r.kind === "gate") {
      gates[i] = (gates[i] ?? 0) + r.cost;
      continue;
    }
    runs[i] = (runs[i] ?? 0) + r.n;
    if (r.cost <= 0) continue;
    const key = r.k ?? "unknown";
    let series = keys.get(key);
    if (!series) {
      series = zeros();
      keys.set(key, series);
    }
    series[i] = (series[i] ?? 0) + r.cost;
    totals[i] = (totals[i] ?? 0) + r.cost;
  }
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  const series = [...keys]
    .map(([key, v]) => ({ key, values: v, total: sum(v) }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return {
    range: filter.range,
    bucket,
    by: filter.by,
    starts,
    series,
    totals,
    gates,
    runs,
    total: sum(totals),
    gateTotal: sum(gates),
    runCount: sum(runs),
  };
}
