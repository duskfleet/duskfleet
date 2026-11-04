import type { DuskFleetConfig } from "../config/types.js";

/**
 * Monthly spending budgets (`budgets` table, migration 18), one per scope: `global` (every
 * run), `agent` (the runs of one agent) or `project` (the runs on one project). The month is
 * the calendar month in UTC, like the daily caps' UTC day; spend is the recorded `cost_usd`
 * of every run created since its first instant (gate runs included: they are spend too).
 */
export const BUDGET_SCOPES = ["global", "agent", "project"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const DEFAULT_WARN_PERCENT = 80;

/**
 * What a budget does with runs whose cost is unknown (migration 23): `count` (default, fail
 * closed) counts each unpriced or still running run at a stand-in amount, `allow` ignores them.
 */
export const UNPRICED_POLICIES = ["count", "allow"] as const;
export type UnpricedPolicy = (typeof UNPRICED_POLICIES)[number];
export const DEFAULT_UNPRICED_POLICY: UnpricedPolicy = "count";

export interface Budget {
  id: string;
  scope: BudgetScope;
  /** Agent id or project id; null for the global budget. */
  scopeId: string | null;
  amountUsd: number;
  /** Share of amountUsd (1-100) past which the budget shows as `warn`. */
  warnPercent: number;
  /** Reaching amountUsd refuses new runs in the scope and pauses its schedules. False = warn only. */
  hardStop: boolean;
  /** How runs of unknown cost count against amountUsd (`count` | `allow`). */
  unpricedPolicy: UnpricedPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetInput {
  scope: BudgetScope;
  scopeId?: string | null;
  amountUsd: number;
  warnPercent?: number;
  hardStop?: boolean;
  unpricedPolicy?: UnpricedPolicy;
}

/**
 * A run of the scope this month whose cost is not known: `unpriced` (it started and ended
 * without a cost, cost_status) or `running` (pending or running: not settled yet). `standInUsd`
 * is what it counts for under `unpriced_policy: count`: the agent's max_budget_usd, or null when
 * the agent sets none (then it counts as the whole remaining budget).
 */
export interface UnknownCostRun {
  id: string;
  agentId: string;
  kind: "unpriced" | "running";
  standInUsd: number | null;
}

/** `ok` below warn_percent, `warn` from warn_percent, `over` once the counted spend reaches amount_usd. */
export type BudgetState = "ok" | "warn" | "over";

export interface BudgetStatus extends Budget {
  /** First instant of the current UTC month: what spentUsd is counted from. */
  periodStart: string;
  /** Recorded cost (reported or estimated) of the scope's runs this month. */
  spentUsd: number;
  /** Runs of the month that ended without a cost (cost_status unpriced). */
  unpricedRuns: number;
  /** Runs pending or running now: their cost is not settled. */
  runningRuns: number;
  /** What the unpriced and running runs count for (0 under `unpriced_policy: allow`). */
  standInUsd: number;
  /** spentUsd + standInUsd: what percent and state compare with amountUsd. */
  countedUsd: number;
  /** countedUsd / amountUsd * 100, rounded to one decimal. */
  percent: number;
  state: BudgetState;
  /**
   * Over only because of the running runs' stand-ins: the hard stop refuses new runs but does
   * not pause schedules, the state settles when those runs end.
   */
  overByRunning: boolean;
}

/**
 * A run refused by a hard-stop budget. Not a BusyError nor a DailyCapError: it clears only
 * when the month turns or the budget is raised. The scheduler records `skipped_budget` on the
 * class, never on the text.
 */
export class BudgetError extends Error {
  override readonly name = "BudgetError";
}

/** 00:00 UTC of the first day of the month `now` falls in, as the ISO string runs.created_at is compared with. */
export function utcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** First instant of the next UTC month: when a budget's spend resets. */
export function utcNextMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

const roundUsd = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Spend plus the stand-ins of the runs of unknown cost: each counts as its standInUsd, and one
 * without (no max_budget_usd) as the whole remaining budget, so the total reaches amountUsd.
 */
function countWithStandIns(amountUsd: number, spentUsd: number, runs: readonly UnknownCostRun[]): number {
  let counted = spentUsd;
  let unbounded = false;
  for (const r of runs) {
    if (r.standInUsd === null) unbounded = true;
    else counted += r.standInUsd;
  }
  return unbounded ? Math.max(counted, amountUsd) : counted;
}

/**
 * A budget's state this month. Under `unpriced_policy: count` the runs of unknown cost (unpriced
 * or still running) count at their stand-in amount: fail closed on the worst known case. Under
 * `allow` only the recorded spend counts.
 */
export function budgetStatus(
  budget: Budget,
  spentUsd: number,
  periodStart: string,
  unknown: readonly UnknownCostRun[] = [],
): BudgetStatus {
  const counting = budget.unpricedPolicy !== "allow";
  const countedUsd = counting ? countWithStandIns(budget.amountUsd, spentUsd, unknown) : spentUsd;
  const settledUsd = counting
    ? countWithStandIns(
        budget.amountUsd,
        spentUsd,
        unknown.filter((r) => r.kind === "unpriced"),
      )
    : spentUsd;
  const percent = Math.round((countedUsd / budget.amountUsd) * 1000) / 10;
  const over = countedUsd >= budget.amountUsd;
  const state: BudgetState = over ? "over" : percent >= budget.warnPercent ? "warn" : "ok";
  return {
    ...budget,
    periodStart,
    spentUsd: roundUsd(spentUsd),
    unpricedRuns: unknown.filter((r) => r.kind === "unpriced").length,
    runningRuns: unknown.filter((r) => r.kind === "running").length,
    standInUsd: roundUsd(countedUsd - spentUsd),
    countedUsd: roundUsd(countedUsd),
    percent,
    state,
    overByRunning: over && settledUsd < budget.amountUsd,
  };
}

/** A run of unknown cost as the repository reads it, before its stand-in is resolved. */
export interface UnknownCostRow {
  id: string;
  agentId: string;
  kind: "unpriced" | "running";
}

/** What computing a budget's state reads: the rows and the spend of a scope (BudgetRepository). */
export interface BudgetSource {
  list(): Budget[];
  spentSince(b: Pick<Budget, "scope" | "scopeId">, sinceIso: string, projectPath?: string | null): number;
  unknownCostSince(
    b: Pick<Budget, "scope" | "scopeId">,
    sinceIso: string,
    projectPath?: string | null,
  ): UnknownCostRow[];
}

/**
 * The runs of unknown cost a budget counts this month, each with its stand-in: the agent's
 * max_budget_usd as configured now, null when unset or the agent is gone.
 */
export function unknownCostRuns(
  source: BudgetSource,
  config: Pick<DuskFleetConfig, "projects" | "agents">,
  b: Pick<Budget, "scope" | "scopeId">,
  now: Date = new Date(),
): UnknownCostRun[] {
  const projectPath = b.scope === "project" ? (config.projects.get(b.scopeId ?? "")?.path ?? null) : null;
  return source.unknownCostSince(b, utcMonthStart(now), projectPath).map((r) => ({
    ...r,
    standInUsd: config.agents.get(r.agentId)?.maxBudgetUsd ?? null,
  }));
}

/** One budget with this month's spend; a project budget also counts runs started with the project's path. */
export function budgetStatusOf(
  source: BudgetSource,
  config: Pick<DuskFleetConfig, "projects" | "agents">,
  b: Budget,
  now: Date = new Date(),
): BudgetStatus {
  const since = utcMonthStart(now);
  const projectPath = b.scope === "project" ? (config.projects.get(b.scopeId ?? "")?.path ?? null) : null;
  return budgetStatus(b, source.spentSince(b, since, projectPath), since, unknownCostRuns(source, config, b, now));
}

/** Every budget with this month's spend and state: what list_budgets, the CLI and the dashboard show. */
export function budgetStatuses(
  source: BudgetSource,
  config: Pick<DuskFleetConfig, "projects" | "agents">,
  now: Date = new Date(),
): BudgetStatus[] {
  return source.list().map((b) => budgetStatusOf(source, config, b, now));
}

/**
 * The budget that applies to a view of the spend: the global one when the view is unfiltered,
 * the agent's (else the project's) when it is filtered. A filtered view never falls back to the
 * global budget: drawn against one agent's spend it would read as that agent's limit. Null when
 * the scope in view has no budget.
 */
export function budgetForScope<T extends Pick<Budget, "scope" | "scopeId">>(
  budgets: readonly T[],
  view: { agentId?: string; projectId?: string },
): T | null {
  const find = (scope: BudgetScope, id: string | null) =>
    budgets.find((b) => b.scope === scope && (b.scopeId ?? null) === id) ?? null;
  if (!view.agentId && !view.projectId) return find("global", null);
  return (
    (view.agentId ? find("agent", view.agentId) : null) ?? (view.projectId ? find("project", view.projectId) : null)
  );
}

/** "global", "agent foo", "project bar": how messages name a budget. */
export function budgetLabel(b: Pick<Budget, "scope" | "scopeId">): string {
  return b.scope === "global" ? "global" : `${b.scope} ${b.scopeId}`;
}

/** Why a run is refused by this (over, hard-stop) budget. */
export function budgetRefusal(s: BudgetStatus, pausedSchedules: string[], now: Date): string {
  const paused = pausedSchedules.length
    ? ` Paused ${pausedSchedules.length} schedule(s) of that scope: ${pausedSchedules.join(", ")}.`
    : "";
  const unknown = [
    s.unpricedRuns ? `${s.unpricedRuns} unpriced run(s)` : "",
    s.runningRuns ? `${s.runningRuns} running run(s)` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const counted =
    s.standInUsd > 0
      ? `$${s.countedUsd} counted of $${s.amountUsd} this month, UTC: $${s.spentUsd} recorded plus $${s.standInUsd} standing in for ${unknown} (unpriced_policy: count)`
      : `$${s.spentUsd} of $${s.amountUsd} this month, UTC`;
  if (s.overByRunning) {
    return (
      `budget: the ${budgetLabel(s)} budget is spent counting the runs still going (${counted}); ` +
      `hard_stop refuses new runs until they end and their cost is known.`
    );
  }
  return (
    `budget: the ${budgetLabel(s)} budget is spent (${counted}); ` +
    `hard_stop refuses new runs until ${utcNextMonthStart(now).slice(0, 10)} or until the budget is raised` +
    `${s.unpricedRuns ? " (or set unpriced_policy: allow on it)" : ""}.${paused}`
  );
}

/**
 * Validates a budget before it is written: shared by MCP, CLI and tests. The scope id must name
 * a configured agent / project (global takes none), the amount is > 0, warn_percent a whole
 * number 1-100, unpriced_policy count (default) or allow. Returns the normalised input.
 */
export function validateBudgetInput(
  config: Pick<DuskFleetConfig, "agents" | "projects">,
  input: BudgetInput,
): Required<BudgetInput> {
  if (!(BUDGET_SCOPES as readonly string[]).includes(input.scope)) {
    throw new Error(`scope must be one of ${BUDGET_SCOPES.join(", ")}`);
  }
  const scopeId = input.scopeId ?? null;
  if (input.scope === "global") {
    if (scopeId !== null) throw new Error("the global budget takes no scope_id");
  } else if (!scopeId) {
    throw new Error(`a ${input.scope} budget needs scope_id (the ${input.scope} id)`);
  } else if (input.scope === "agent" && !config.agents.has(scopeId)) {
    throw new Error(`unknown agent: ${scopeId} (list_agents)`);
  } else if (input.scope === "project" && !config.projects.has(scopeId)) {
    throw new Error(`unknown project: ${scopeId} (list_projects)`);
  }
  if (typeof input.amountUsd !== "number" || !Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    throw new Error("amount_usd must be a number > 0");
  }
  const warnPercent = input.warnPercent ?? DEFAULT_WARN_PERCENT;
  if (!Number.isInteger(warnPercent) || warnPercent < 1 || warnPercent > 100) {
    throw new Error("warn_percent must be a whole number from 1 to 100");
  }
  const unpricedPolicy = input.unpricedPolicy ?? DEFAULT_UNPRICED_POLICY;
  if (!(UNPRICED_POLICIES as readonly string[]).includes(unpricedPolicy)) {
    throw new Error(`unpriced_policy must be one of ${UNPRICED_POLICIES.join(", ")}`);
  }
  return {
    scope: input.scope,
    scopeId,
    amountUsd: input.amountUsd,
    warnPercent,
    hardStop: input.hardStop ?? true,
    unpricedPolicy,
  };
}
