/**
 * Pure helpers of the /trends page: rates, the worsening agent, axis ticks and label
 * placement. No data access (lib/data.ts) and no JSX, so test/trends.test.mjs runs them as is.
 */
import type { OutcomeCounts, TrendBucket, TrendRange } from "@duskfleet/core";

export const RANGE_LABELS: Record<TrendRange, string> = {
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
};

/** "No finished runs in the last month". */
export const RANGE_PHRASES: Record<TrendRange, string> = {
  "1m": "the last month",
  "3m": "the last 3 months",
  "6m": "the last 6 months",
  "1y": "the last year",
};

const UNITS: Record<TrendBucket, { adverb: string; one: string; many: string }> = {
  day: { adverb: "daily", one: "day", many: "days" },
  week: { adverb: "weekly", one: "week", many: "weeks" },
  month: { adverb: "monthly", one: "month", many: "months" },
};

export const unitName = (bucket: TrendBucket) => UNITS[bucket].one;
export const unitCount = (n: number, bucket: TrendBucket) => `${n} ${n === 1 ? UNITS[bucket].one : UNITS[bucket].many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "20 Jul" for a day or week bucket, "Oct" for a month (UTC dates, as the buckets). */
export function bucketLabel(start: string, bucket: TrendBucket): string {
  const d = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  const month = MONTHS[d.getUTCMonth()] ?? "";
  return bucket === "month" ? month : `${d.getUTCDate()} ${month}`;
}

/** "7 Sep" for an ISO instant, UTC. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}`;
}

/** "weekly · 13 weeks to Fri 30 Oct": the granularity line next to the period selector. */
export function granularityText(bucket: TrendBucket, count: number, now: Date): string {
  return `${UNITS[bucket].adverb} · ${unitCount(count, bucket)} to ${WEEKDAYS[now.getUTCDay()]} ${dayLabel(now.toISOString())}`;
}

/** Clean share of a bucket's finished runs, 0..100; null when nothing finished (a gap, not a zero). */
export function cleanRate(c: OutcomeCounts): number | null {
  return c.finished > 0 ? (c.clean / c.finished) * 100 : null;
}

/** Indexes of the non-null values. */
export function pointIndexes(values: ReadonlyArray<number | null>): number[] {
  return values.flatMap((v, i) => (v === null ? [] : [i]));
}

/**
 * The agent whose clean rate fell the most between its first and last point of the period,
 * when it fell by at least `minDrop` points over at least 3 points; null otherwise.
 */
export function worseningAgent(
  series: ReadonlyArray<{ agentId: string; rates: ReadonlyArray<number | null> }>,
  minDrop = 5,
): { agentId: string; drop: number; buckets: number } | null {
  let worst: { agentId: string; drop: number; buckets: number } | null = null;
  for (const s of series) {
    const idx = pointIndexes(s.rates);
    if (idx.length < 3) continue;
    const first = idx[0] as number;
    const last = idx[idx.length - 1] as number;
    const drop = Math.round((s.rates[first] as number) - (s.rates[last] as number));
    if (drop >= minDrop && (!worst || drop > worst.drop)) worst = { agentId: s.agentId, drop, buckets: last - first };
  }
  return worst;
}

/**
 * Percent axis up to 100: 0–100 in steps of 25 when a value is under 40, otherwise steps of 10
 * from a floor under the lowest value, 50 at most.
 */
export function percentAxis(values: ReadonlyArray<number>): { min: number; max: number; ticks: number[] } {
  const low = values.length ? Math.min(...values) : 100;
  const step = low < 40 ? 25 : 10;
  const min = low < 40 ? 0 : Math.min(50, Math.floor((low - 5) / 10) * 10);
  const ticks: number[] = [];
  for (let t = min; t <= 100; t += step) ticks.push(t);
  return { min, max: 100, ticks };
}

/** A count axis from 0 to a round maximum with about three steps: 0 10 20 30. */
export function countAxis(maxValue: number): { max: number; ticks: number[] } {
  const target = Math.max(1, maxValue) / 3;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  // runs are whole: never a step under 1
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= target) ?? magnitude);
  const max = Math.max(step, Math.ceil(maxValue / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  return { max, ticks };
}

/** At most `max` evenly spaced bucket indexes for the x labels, always ending on the last bucket. */
export function xTickIndexes(n: number, max = 7): number[] {
  if (n <= 0) return [];
  const every = Math.max(1, Math.ceil(n / max));
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= every) out.unshift(i);
  return out;
}

/**
 * Vertical positions (px) for end-of-line labels: each label at its line's end, pushed down
 * so labels keep `gap` px apart, then pulled back up when the last one would leave `height`,
 * and clamped to [0, height] so no label leaves the plot box.
 */
export function spreadLabels<T extends { top: number }>(items: readonly T[], gap: number, height: number): T[] {
  const sorted = [...items].sort((a, b) => a.top - b.top).map((it) => ({ ...it, top: Math.max(0, it.top) }));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as T;
    const cur = sorted[i] as T;
    if (cur.top < prev.top + gap) cur.top = prev.top + gap;
  }
  const overflow = (sorted.at(-1)?.top ?? 0) - height;
  if (overflow > 0) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const cur = sorted[i] as T;
      const next = sorted[i + 1];
      cur.top = Math.min(cur.top, next ? next.top - gap : height);
    }
  }
  for (const it of sorted) it.top = Math.min(height, Math.max(0, it.top));
  return sorted;
}

/** Lines drawn on the clean-rate chart at most, "all agents" included. */
export const MAX_DRAWN_LINES = 6;
/** Agents a user may tick: the other line is "all agents". */
export const MAX_TICKED = MAX_DRAWN_LINES - 1;

/** One row of the ranked agent table of the clean-rate panel. */
export interface AgentRow {
  agentId: string;
  /** Clean rate of the agent's last point in the period, 0..100 (rounded); null without a point. */
  rate: number | null;
  /** Last point minus first point, rounded; null with fewer than 2 points. */
  delta: number | null;
  /** Finished runs in the period. */
  runs: number;
  rates: ReadonlyArray<number | null>;
}

/** The table's rows, lowest clean rate first (agents without a rate last), ties by id. */
export function agentRows(
  series: ReadonlyArray<{ agentId: string; counts: ReadonlyArray<OutcomeCounts> }>,
): AgentRow[] {
  return series
    .map((a) => {
      const rates = a.counts.map(cleanRate);
      const idx = pointIndexes(rates);
      const first = idx[0];
      const last = idx.at(-1);
      return {
        agentId: a.agentId,
        rate: last === undefined ? null : Math.round(rates[last] as number),
        delta:
          first === undefined || last === undefined || first === last
            ? null
            : Math.round((rates[last] as number) - (rates[first] as number)),
        runs: a.counts.reduce((n, c) => n + c.finished, 0),
        rates,
      };
    })
    .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || a.agentId.localeCompare(b.agentId));
}

/** Default lines when there are too many agents: the most-worsening one plus the 4 lowest others. */
export function defaultSelection(rows: ReadonlyArray<AgentRow>, worst: string | null): string[] {
  const lowest = rows.filter((r) => r.agentId !== worst && r.rate !== null).slice(0, 4);
  return [...(worst ? [worst] : []), ...lowest.map((r) => r.agentId)];
}

/** "↓8", "↑4", "·0"; "–" without two points. */
export function deltaText(delta: number | null): string {
  if (delta === null) return "–";
  return delta < 0 ? `↓${-delta}` : delta > 0 ? `↑${delta}` : "·0";
}

/** Several agents' series of one range as one: the scope of the other two charts for a multi-value ?agent=. */
export function mergeSeries<
  S extends {
    overall: OutcomeCounts[];
    byAgent: Array<{ agentId: string; counts: OutcomeCounts[] }>;
    totals: OutcomeCounts;
    reasons: Array<{ reason: R; count: number }>;
    firstRunAt: string | null;
  },
  R extends string,
>(parts: readonly S[]): S | undefined {
  const [head, ...rest] = parts;
  if (!head) return undefined;
  const add = (a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts => ({
    finished: a.finished + b.finished,
    clean: a.clean + b.clean,
    needsReview: a.needsReview + b.needsReview,
    cancelled: a.cancelled + b.cancelled,
  });
  const reasons = new Map<R, number>();
  for (const p of parts) for (const r of p.reasons) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count);
  const firsts = parts.map((p) => p.firstRunAt).filter((f): f is string => f !== null);
  return {
    ...head,
    overall: head.overall.map((c, i) => rest.reduce((acc, p) => add(acc, p.overall[i] as OutcomeCounts), c)),
    byAgent: parts.flatMap((p) => p.byAgent),
    totals: rest.reduce((acc, p) => add(acc, p.totals), head.totals),
    reasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    firstRunAt: firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null,
  };
}
