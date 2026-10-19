/**
 * A schedule with the state of the run it last started. `started` is only the outcome of
 * the tick; the row has to say how that run *ended* (on 2026-10-14 a budget-exhausted run
 * stayed green behind a `started` for 11 hours). One query for all rows, no result blobs.
 * MCP, CLI and the dashboard all go through here.
 */
import { type LastRunSummary, lastRunSummary, type RunSummary } from "../observability/run.js";
import type { Schedule } from "./types.js";

export type ScheduleWithLastRun = Schedule & { lastRun: LastRunSummary | null };

/** Anything that can fetch run summaries by id: `RunRepository` (dashboard) or `RunManager` (MCP, CLI). */
export interface RunSummarySource {
  summaries(ids: string[]): RunSummary[];
}

export function attachLastRun(schedules: Schedule[], runs: RunSummarySource): ScheduleWithLastRun[] {
  const ids = schedules.map((s) => s.lastRunId).filter((id): id is string => id !== null);
  const byId = new Map<string, RunSummary>();
  if (ids.length) for (const r of runs.summaries(ids)) byId.set(r.id, r);
  return schedules.map((s) => ({
    ...s,
    lastRun: lastRunSummary(s.lastRunId ? (byId.get(s.lastRunId) ?? null) : null),
  }));
}
