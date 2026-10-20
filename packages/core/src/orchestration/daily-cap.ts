import type { AgentDefinition } from "../config/types.js";

/**
 * A run refused by an agent's daily cap (`max_daily_runs`, `max_daily_cost_usd`). Not a
 * BusyError: busy clears when a run ends, a cap only at the next UTC midnight. The scheduler
 * checks the class, never the text, to record a tick as `skipped_daily_cap`.
 */
export class DailyCapError extends Error {
  override readonly name = "DailyCapError";
}

/** 00:00 UTC of the day `now` falls in, as the ISO string runs.created_at is compared with. */
export function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Why one more run of `agent` is over its daily caps, given what it used since 00:00 UTC, or
 * null. The run cap counts every run started today; the cost cap is reached once today's
 * recorded cost is at or above it.
 */
export function dailyCapReason(agent: AgentDefinition, used: { runs: number; costUsd: number }): string | null {
  if (agent.maxDailyRuns !== undefined && used.runs >= agent.maxDailyRuns) {
    return (
      `daily cap: agent ${agent.id} already started ${used.runs} runs today (UTC); ` +
      `max_daily_runs is ${agent.maxDailyRuns}. It resets at 00:00 UTC, or raise it.`
    );
  }
  if (agent.maxDailyCostUsd !== undefined && used.costUsd >= agent.maxDailyCostUsd) {
    return (
      `daily cap: agent ${agent.id} already spent $${Math.round(used.costUsd * 10_000) / 10_000} today (UTC); ` +
      `max_daily_cost_usd is ${agent.maxDailyCostUsd}. It resets at 00:00 UTC, or raise it.`
    );
  }
  return null;
}
