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
  createdAt: string;
  updatedAt: string;
}

export interface BudgetInput {
  scope: BudgetScope;
  scopeId?: string | null;
  amountUsd: number;
  warnPercent?: number;
  hardStop?: boolean;
}

/** `ok` below warn_percent, `warn` from warn_percent, `over` once the spend reaches amount_usd. */
export type BudgetState = "ok" | "warn" | "over";

export interface BudgetStatus extends Budget {
  /** First instant of the current UTC month: what spentUsd is counted from. */
  periodStart: string;
  spentUsd: number;
  /** spentUsd / amountUsd * 100, rounded to one decimal. */
  percent: number;
  state: BudgetState;
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

export function budgetStatus(budget: Budget, spentUsd: number, periodStart: string): BudgetStatus {
  const percent = Math.round((spentUsd / budget.amountUsd) * 1000) / 10;
  const state: BudgetState = spentUsd >= budget.amountUsd ? "over" : percent >= budget.warnPercent ? "warn" : "ok";
  return { ...budget, periodStart, spentUsd: Math.round(spentUsd * 10_000) / 10_000, percent, state };
}

/** What computing a budget's state reads: the rows and the spend of a scope (BudgetRepository). */
export interface BudgetSource {
  list(): Budget[];
  spentSince(b: Pick<Budget, "scope" | "scopeId">, sinceIso: string, projectPath?: string | null): number;
}

/** One budget with this month's spend; a project budget also counts runs started with the project's path. */
export function budgetStatusOf(
  source: BudgetSource,
  config: Pick<DuskFleetConfig, "projects">,
  b: Budget,
  now: Date = new Date(),
): BudgetStatus {
  const since = utcMonthStart(now);
  const projectPath = b.scope === "project" ? (config.projects.get(b.scopeId ?? "")?.path ?? null) : null;
  return budgetStatus(b, source.spentSince(b, since, projectPath), since);
}

/** Every budget with this month's spend and state: what list_budgets, the CLI and the dashboard show. */
export function budgetStatuses(
  source: BudgetSource,
  config: Pick<DuskFleetConfig, "projects">,
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
  return (
    `budget: the ${budgetLabel(s)} budget is spent ($${s.spentUsd} of $${s.amountUsd} this month, UTC); ` +
    `hard_stop refuses new runs until ${utcNextMonthStart(now).slice(0, 10)} or until the budget is raised.${paused}`
  );
}

/**
 * Validates a budget before it is written: shared by MCP, CLI and tests. The scope id must name
 * a configured agent / project (global takes none), the amount is > 0, warn_percent a whole
 * number 1-100. Returns the normalised input.
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
  return { scope: input.scope, scopeId, amountUsd: input.amountUsd, warnPercent, hardStop: input.hardStop ?? true };
}
