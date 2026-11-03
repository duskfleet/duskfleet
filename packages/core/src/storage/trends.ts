/**
 * Outcomes over time, for the dashboard's /trends page: finished runs per UTC bucket (day,
 * ISO week, month), split by the stored review verdict, per agent and overall, plus the review
 * reasons of the period. Real runs only (`kind = 'run'`), as the overview KPIs: a gate run is a
 * schedule's yes/no check, not work to judge.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ReviewReason } from "../observability/run.js";
import { NEEDS_REVIEW_SQL } from "./runs.js";

export const TREND_RANGES = ["1m", "3m", "6m", "1y"] as const;
export type TrendRange = (typeof TREND_RANGES)[number];
export type TrendBucket = "day" | "week" | "month";

/** Granularity and length of each range: days for a month, ISO weeks up to six months, months for a year. */
export const TREND_RANGE_SPEC: Record<TrendRange, { bucket: TrendBucket; count: number }> = {
  "1m": { bucket: "day", count: 30 },
  "3m": { bucket: "week", count: 13 },
  "6m": { bucket: "week", count: 26 },
  "1y": { bucket: "month", count: 12 },
};

const DAY_MS = 24 * 3600_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Start (UTC midnight, ms) of the bucket `ms` falls in. Weeks start on Monday (ISO). */
function bucketStart(ms: number, bucket: TrendBucket): number {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === "day") return day;
  if (bucket === "week") return day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(ms: number, bucket: TrendBucket): number {
  if (bucket === "day") return ms + DAY_MS;
  if (bucket === "week") return ms + 7 * DAY_MS;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * The buckets of `range`, oldest first, the last one being the bucket `now` falls in. Every
 * bucket is listed, with or without runs, so the axis does not move. `starts` are UTC dates
 * (YYYY-MM-DD); `end` is the exclusive ISO instant after the last bucket.
 */
export function trendBuckets(
  range: TrendRange,
  now: Date,
): { bucket: TrendBucket; starts: string[]; from: string; end: string } {
  const { bucket, count } = TREND_RANGE_SPEC[range];
  const last = bucketStart(now.getTime(), bucket);
  const starts: number[] = [last];
  for (let i = 1; i < count; i++) {
    const prev = starts[0] as number;
    // one bucket back: the start of the bucket the instant before `prev` falls in
    starts.unshift(bucketStart(prev - 1, bucket));
  }
  const first = starts[0] as number;
  return {
    bucket,
    starts: starts.map(ymd),
    from: new Date(first).toISOString(),
    end: new Date(nextBucket(last, bucket)).toISOString(),
  };
}

/** Finished runs of one bucket. clean + needsReview + cancelled = finished (cancelled is never needs-review). */
export interface OutcomeCounts {
  finished: number;
  clean: number;
  needsReview: number;
  cancelled: number;
}

export interface OutcomeSeries {
  range: TrendRange;
  bucket: TrendBucket;
  /** Bucket start dates, UTC, oldest first; every series below is aligned with it. */
  starts: string[];
  overall: OutcomeCounts[];
  /** One series per agent with at least one finished run in the period, most finished runs first. */
  byAgent: Array<{ agentId: string; counts: OutcomeCounts[] }>;
  /** Totals of the period. */
  totals: OutcomeCounts;
  /** Runs per stored review reason over the period, most frequent first; reasons with no run are left out. */
  reasons: Array<{ reason: ReviewReason; count: number }>;
  /** created_at of the first finished run in this scope, any period; null when there is none. */
  firstRunAt: string | null;
}

export interface OutcomeSeriesFilter {
  range: TrendRange;
  agentId?: string;
  projectPath?: string;
  /** Defaults to the current time; tests pin it. */
  now?: Date;
}

// SQLite reads the ISO strings of created_at as UTC. 'weekday 0' moves to the Sunday on or
// after the date: six days back is that ISO week's Monday.
const BUCKET_SQL: Record<TrendBucket, string> = {
  day: "date(created_at)",
  week: "date(created_at, 'weekday 0', '-6 days')",
  month: "date(created_at, 'start of month')",
};

const FINISHED_SQL = "status IN ('completed','failed','timed_out','cancelled')";

const empty = (): OutcomeCounts => ({ finished: 0, clean: 0, needsReview: 0, cancelled: 0 });

export function outcomeSeries(db: DatabaseSync, filter: OutcomeSeriesFilter): OutcomeSeries {
  const { bucket, starts, from, end } = trendBuckets(filter.range, filter.now ?? new Date());
  const scope: string[] = ["kind = 'run'", FINISHED_SQL];
  const scopeValues: string[] = [];
  if (filter.agentId) {
    scope.push("agent_id = ?");
    scopeValues.push(filter.agentId);
  }
  if (filter.projectPath) {
    scope.push("project_path = ?");
    scopeValues.push(filter.projectPath);
  }
  const where = [...scope, "created_at >= ?", "created_at < ?"].join(" AND ");
  const values = [...scopeValues, from, end];

  const rows = db
    .prepare(
      `SELECT agent_id, ${BUCKET_SQL[bucket]} AS b,
              COUNT(*)                                                    AS finished,
              SUM(status = 'completed' AND NOT ${NEEDS_REVIEW_SQL})       AS clean,
              SUM(${NEEDS_REVIEW_SQL})                                    AS needs_review,
              SUM(status = 'cancelled' AND NOT ${NEEDS_REVIEW_SQL})       AS cancelled
       FROM runs WHERE ${where}
       GROUP BY agent_id, b`,
    )
    .all(...values) as Array<{
    agent_id: string;
    b: string;
    finished: number;
    clean: number;
    needs_review: number;
    cancelled: number;
  }>;

  const index = new Map(starts.map((s, i) => [s, i]));
  const overall = starts.map(empty);
  const totals = empty();
  const agents = new Map<string, OutcomeCounts[]>();
  for (const r of rows) {
    const i = index.get(r.b);
    if (i === undefined) continue;
    let series = agents.get(r.agent_id);
    if (!series) {
      series = starts.map(empty);
      agents.set(r.agent_id, series);
    }
    for (const target of [series[i] as OutcomeCounts, overall[i] as OutcomeCounts, totals]) {
      target.finished += r.finished;
      target.clean += r.clean;
      target.needsReview += r.needs_review;
      target.cancelled += r.cancelled;
    }
  }
  const sum = (counts: OutcomeCounts[]) => counts.reduce((n, c) => n + c.finished, 0);
  const byAgent = [...agents]
    .map(([agentId, counts]) => ({ agentId, counts }))
    .sort((a, b) => sum(b.counts) - sum(a.counts) || a.agentId.localeCompare(b.agentId));

  const reasons = db
    .prepare(
      `SELECT j.value AS reason, COUNT(*) AS n
       FROM runs, json_each(COALESCE(runs.review_reasons_json, '[]')) AS j
       WHERE ${where}
       GROUP BY j.value ORDER BY n DESC, j.value`,
    )
    .all(...values) as Array<{ reason: ReviewReason; n: number }>;

  const first = db
    .prepare(`SELECT MIN(created_at) AS first FROM runs WHERE ${scope.join(" AND ")}`)
    .get(...scopeValues) as { first: string | null };

  return {
    range: filter.range,
    bucket,
    starts,
    overall,
    byAgent,
    totals,
    reasons: reasons.map((r) => ({ reason: r.reason, count: r.n })),
    firstRunAt: first.first,
  };
}

/**
 * Stored review reasons of an agent's last `limit` runs that needed review, for the trend's
 * callout ("7 of the last 10 reviews were permission denials"). Most frequent first.
 */
export function recentReviewReasons(
  db: DatabaseSync,
  agentId: string,
  limit = 10,
  projectPath?: string,
): { reviews: number; reasons: Array<{ reason: ReviewReason; count: number }> } {
  const rows = db
    .prepare(
      `SELECT review_reasons_json AS reasons FROM runs
       WHERE kind = 'run' AND agent_id = ? AND ${NEEDS_REVIEW_SQL} ${projectPath ? "AND project_path = ?" : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...(projectPath ? [agentId, projectPath, limit] : [agentId, limit])) as Array<{ reasons: string }>;
  const counts = new Map<ReviewReason, number>();
  for (const r of rows) {
    let list: unknown;
    try {
      list = JSON.parse(r.reasons);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const reason of new Set(list as ReviewReason[])) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return {
    reviews: rows.length,
    reasons: [...counts]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}
