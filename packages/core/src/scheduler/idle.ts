/**
 * Idle cost: what a schedule spends on runs that found nothing to do. On 2026-10-14, 49 of
 * the day's 50 scheduled runs ended "nothing to do" at $0.10-0.60 each; nothing showed it.
 * A run is a no-op when its final message matches the schedule's `noop_pattern` (default
 * from `scheduler.noop_pattern`). Generic: the pattern is whatever the agent says when idle.
 */
import type { Run } from "../observability/run.js";

/** What scheduled agents typically say when they find no work. Matched case-insensitively. */
export const DEFAULT_NOOP_PATTERN = "/nothing to do|no .* in ready/i";

/**
 * Parse a no-op marker: `/source/flags` (a JavaScript regex literal) or a plain string, which
 * is matched as a case-insensitive regex. Throws on an invalid expression.
 */
export function parseNoopPattern(pattern: string): RegExp {
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(pattern.trim());
  try {
    return literal ? new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, "")) : new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`invalid noop_pattern ${JSON.stringify(pattern)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A finished run whose final message matches the marker. Failed runs are never no-ops: they need review instead. */
export function isNoopRun(run: Pick<Run, "status" | "resultText">, pattern: RegExp): boolean {
  return run.status === "completed" && run.resultText !== null && pattern.test(run.resultText);
}

export interface IdleStats {
  /** Window start (ISO). */
  since: string;
  days: number;
  /** Every tick considered (started, resumed, skipped, error). */
  ticks: number;
  /** Ticks that started a run (started + resumed). */
  fires: number;
  /** Runs of the schedule created in the window. */
  runs: number;
  /** Completed runs whose final message matched the no-op marker. */
  noopRuns: number;
  noopCostUsd: number;
  /** All runs of the schedule in the window. */
  costUsd: number;
  /** The marker used, as written. */
  noopPattern: string;
  /** Ticks on which the gate ran (command or agent). */
  gateChecks: number;
  /** Ticks the gate skipped (no work). */
  gateSkips: number;
  /** What the gate agent runs cost (command gates cost nothing). Not included in costUsd. */
  gateCostUsd: number;
}

/** Idle stats of one schedule over the last `days` (default 7), read from its firings and runs. */
export function scheduleIdleStats(
  repo: {
    firingCountsSince(id: string, since: string): Record<string, number>;
    runOutcomesSince(id: string, since: string): Array<Pick<Run, "status" | "resultText" | "costUsd">>;
    gateSpendSince(id: string, since: string): { gateChecks: number; gateCostUsd: number };
  },
  schedule: { id: string; noopPattern: string | null },
  defaultPattern: string,
  now: Date = new Date(),
  days = 7,
): IdleStats {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const counts = repo.firingCountsSince(schedule.id, since);
  const ticks = Object.values(counts).reduce((a, b) => a + b, 0);
  const fires = (counts["started"] ?? 0) + (counts["resumed"] ?? 0);
  const gates = repo.gateSpendSince(schedule.id, since);
  return {
    ...computeIdleStats({ runs: repo.runOutcomesSince(schedule.id, since), ticks, fires, pattern: schedule.noopPattern ?? defaultPattern, since, days }),
    gateSkips: counts["skipped_gate"] ?? 0,
    gateChecks: gates.gateChecks,
    gateCostUsd: Math.round(gates.gateCostUsd * 10_000) / 10_000,
  };
}

export function computeIdleStats(input: {
  runs: Array<Pick<Run, "status" | "resultText" | "costUsd">>;
  ticks: number;
  fires: number;
  pattern: string;
  since: string;
  days: number;
}): Omit<IdleStats, "gateChecks" | "gateSkips" | "gateCostUsd"> {
  const re = parseNoopPattern(input.pattern);
  let noopRuns = 0;
  let noopCostUsd = 0;
  let costUsd = 0;
  for (const r of input.runs) {
    costUsd += r.costUsd ?? 0;
    if (isNoopRun(r, re)) {
      noopRuns += 1;
      noopCostUsd += r.costUsd ?? 0;
    }
  }
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    since: input.since,
    days: input.days,
    ticks: input.ticks,
    fires: input.fires,
    runs: input.runs.length,
    noopRuns,
    noopCostUsd: round(noopCostUsd),
    costUsd: round(costUsd),
    noopPattern: input.pattern,
  };
}
