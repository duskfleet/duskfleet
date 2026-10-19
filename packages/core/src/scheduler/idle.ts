/**
 * Idle cost: what a schedule spends on runs that found nothing to do. On 2026-10-14, 49 of
 * the day's 50 scheduled runs ended "nothing to do" at $0.10-0.60 each; nothing showed it.
 * A run is a no-op when its final message matches the schedule's `noop_pattern` (default
 * from `scheduler.noop_pattern`). Generic: the pattern is whatever the agent says when idle.
 */
import type { Run } from "../observability/run.js";
import type { RunOutcomes } from "./types.js";

/**
 * What scheduled agents typically say when they find no work, matched case-insensitively at
 * the start of the final message: a run that did work and mentions "nothing to do" later on
 * is not idle.
 */
export const DEFAULT_NOOP_PATTERN = "/^\\s*(nothing to do|no .* in ready)/i";

/**
 * How much of a final message the marker is tested against. Bounds a user (or LLM) supplied
 * regex with bad backtracking: it runs on the MCP / serve event loop.
 */
export const NOOP_TEXT_LIMIT = 2000;

/**
 * Parse a no-op marker: `/source/flags` (a JavaScript regex literal) or a plain string, which
 * is matched as a case-insensitive regex. Surrounding whitespace is ignored. Throws on an
 * empty or invalid expression.
 */
export function parseNoopPattern(pattern: string): RegExp {
  const p = pattern.trim();
  if (p === "") throw new Error("invalid noop_pattern: empty");
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(p);
  try {
    return literal ? new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, "")) : new RegExp(p, "i");
  } catch (err) {
    throw new Error(
      `invalid noop_pattern ${JSON.stringify(pattern)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * A finished run whose final message matches the marker. Failed runs are never no-ops: they
 * need review instead (so do completed runs with review reasons, filtered out by
 * `runOutcomesSince`).
 */
export function isNoopRun(run: Pick<Run, "status" | "resultText">, pattern: RegExp): boolean {
  return (
    run.status === "completed" && run.resultText !== null && pattern.test(run.resultText.slice(0, NOOP_TEXT_LIMIT))
  );
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
  /**
   * Why the stored marker could not be parsed (a manual DB edit, or stricter parse rules than
   * when it was saved), else null. Then noopRuns and noopCostUsd are 0: only this schedule's
   * stats degrade, never list_schedules, the CLI or the dashboard as a whole.
   */
  noopPatternError: string | null;
}

/** Idle stats of one schedule over the last `days` (default 7), read from its firings and runs. */
export function scheduleIdleStats(
  repo: {
    firingCountsSince(id: string, since: string): Record<string, number>;
    runOutcomesSince(id: string, since: string, textLimit: number): RunOutcomes;
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
  return computeIdleStats({
    outcomes: repo.runOutcomesSince(schedule.id, since, NOOP_TEXT_LIMIT),
    ticks,
    fires,
    pattern: schedule.noopPattern ?? defaultPattern,
    since,
    days,
  });
}

export function computeIdleStats(input: {
  outcomes: RunOutcomes;
  ticks: number;
  fires: number;
  pattern: string;
  since: string;
  days: number;
}): IdleStats {
  let re: RegExp | null = null;
  let noopPatternError: string | null = null;
  try {
    re = parseNoopPattern(input.pattern);
  } catch (err) {
    noopPatternError = err instanceof Error ? err.message : String(err);
  }
  let noopRuns = 0;
  let noopCostUsd = 0;
  for (const r of input.outcomes.completed) {
    if (re && isNoopRun({ status: "completed", resultText: r.resultText }, re)) {
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
    runs: input.outcomes.runs,
    noopRuns,
    noopCostUsd: round(noopCostUsd),
    costUsd: round(input.outcomes.costUsd),
    noopPattern: input.pattern,
    noopPatternError,
  };
}
