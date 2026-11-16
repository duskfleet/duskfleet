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

/**
 * The nav's Runs badge (DS-30): real runs running now, always global (every agent and project).
 * The Runs page's KPI uses the same ACTIVE_SQL but follows that page's agent and project filters.
 */
export const RUNNING_COUNT_SQL = `SELECT COUNT(*) AS n FROM runs WHERE kind = 'run' AND ${ACTIVE_SQL}`;

/** How often the nav re-reads the badge count (GET /api/running) while a page is open. */
export const RUNNING_POLL_MS = 5000;

/** The count in a GET /api/running body, or null when the body is not `{ running: <integer ≥ 0> }`. */
export function parseRunningCount(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const n = (body as { running?: unknown }).running;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/** Whether a run counts as running now (ACTIVE_SQL in memory). */
export function isActiveRun(run: { status: RunStatus }): boolean {
  return ACTIVE_STATUSES.includes(run.status);
}
