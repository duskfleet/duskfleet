import type { RunStatus } from "@duskfleet/core";

/**
 * The dashboard's one definition of "running now": a run not ended yet, `running` or
 * `pending` (being spawned). The Agents page (agentStats, the Running bucket), the Runs
 * page's count (overview) and its Running list (activeRuns) all use it, so the two pages
 * agree. A `pending` row whose process died before the spawn is failed by core's orphan
 * sweep (`recoverOrphans`), not hidden here.
 */
export const ACTIVE_STATUSES: readonly RunStatus[] = ["running", "pending"];

/** ACTIVE_STATUSES as a SQL condition on `runs.status`. */
export const ACTIVE_SQL = `status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(",")})`;

/** Whether a run counts as running now (ACTIVE_SQL in memory). */
export function isActiveRun(run: { status: RunStatus }): boolean {
  return ACTIVE_STATUSES.includes(run.status);
}
