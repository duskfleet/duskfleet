/**
 * SQLite persistence for monthly budgets (migration 18): the rows, the spend they are compared
 * with (from `runs`) and the pause of the schedules of a scope whose hard stop was reached.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Budget,
  type BudgetScope,
  DEFAULT_UNPRICED_POLICY,
  type UnknownCostRow,
  type ValidBudgetInput,
} from "../orchestration/budget.js";

interface BudgetRow {
  id: string;
  scope: string;
  scope_id: string | null;
  amount_usd: number;
  warn_percent: number;
  hard_stop: number;
  unpriced_policy: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBudget(r: BudgetRow): Budget {
  return {
    id: r.id,
    scope: r.scope as BudgetScope,
    scopeId: r.scope_id,
    amountUsd: r.amount_usd,
    warnPercent: r.warn_percent,
    hardStop: r.hard_stop === 1,
    unpricedPolicy: r.unpriced_policy === "allow" ? "allow" : "count",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const positiveUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The cap the run really had: the --max-budget-usd its phases were launched with, summed (main
 * plus wrap-up). When no wrap-up phase is recorded, the main phase's reserve is added back: the
 * run may have died in a wrap-up pass that never got written (the main pass alone runs on the cap
 * minus the reserve). Null when no phase is recorded (a run still going, or swept as an orphan),
 * when one has no budget, or when a main phase without a wrap-up predates the recorded reserve.
 */
function phaseBudgetTotal(json: string | null): number | null {
  if (!json) return null;
  let phases: unknown;
  try {
    phases = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(phases) || phases.length === 0) return null;
  let total = 0;
  let wrapUp = false;
  let reserve: number | null = null;
  for (const p of phases as Array<{ phase?: unknown; budgetUsd?: unknown; reserveUsd?: unknown } | null>) {
    const usd = p?.budgetUsd;
    if (!p || !positiveUsd(usd)) return null;
    total += usd;
    if (p.phase === "wrap_up") wrapUp = true;
    else if (typeof p.reserveUsd === "number" && Number.isFinite(p.reserveUsd) && p.reserveUsd >= 0)
      reserve = p.reserveUsd;
  }
  if (wrapUp) return total;
  return reserve === null ? null : total + reserve;
}

export class BudgetRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Budget[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM budgets ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, scope_id",
        )
        .all() as unknown as BudgetRow[]
    ).map(rowToBudget);
  }

  get(id: string): Budget | null {
    const row = this.db.prepare("SELECT * FROM budgets WHERE id = ?").get(id) as unknown as BudgetRow | undefined;
    return row ? rowToBudget(row) : null;
  }

  find(scope: BudgetScope, scopeId: string | null): Budget | null {
    const row = this.db
      .prepare("SELECT * FROM budgets WHERE scope = ? AND scope_id IS ?")
      .get(scope, scopeId) as unknown as BudgetRow | undefined;
    return row ? rowToBudget(row) : null;
  }

  /**
   * Create the budget of a scope, or replace the one it has (one budget per scope). Input already
   * validated. An unset unpricedPolicy keeps the stored one on update and is `count` on insert.
   */
  upsert(input: ValidBudgetInput): Budget {
    const now = new Date().toISOString();
    const existing = this.find(input.scope, input.scopeId);
    if (existing) {
      this.db
        .prepare(
          "UPDATE budgets SET amount_usd = ?, warn_percent = ?, hard_stop = ?, unpriced_policy = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          input.amountUsd,
          input.warnPercent,
          input.hardStop ? 1 : 0,
          input.unpricedPolicy ?? existing.unpricedPolicy,
          now,
          existing.id,
        );
      return this.get(existing.id)!;
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO budgets (id, scope, scope_id, amount_usd, warn_percent, hard_stop, unpriced_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.scope,
        input.scopeId,
        input.amountUsd,
        input.warnPercent,
        input.hardStop ? 1 : 0,
        input.unpricedPolicy ?? DEFAULT_UNPRICED_POLICY,
        now,
        now,
      );
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM budgets WHERE id = ?").run(id).changes) > 0;
  }

  /**
   * Recorded cost of the runs of a scope created since `sinceIso`. A project counts its runs by
   * id and, for runs started with a path instead of an id, by the project's path.
   */
  spentSince(b: Pick<Budget, "scope" | "scopeId">, sinceIso: string, projectPath: string | null = null): number {
    let r: { cost: number | null };
    if (b.scope === "global") {
      r = this.db.prepare("SELECT SUM(cost_usd) AS cost FROM runs WHERE created_at >= ?").get(sinceIso) as typeof r;
    } else if (b.scope === "agent") {
      r = this.db
        .prepare("SELECT SUM(cost_usd) AS cost FROM runs WHERE agent_id = ? AND created_at >= ?")
        .get(b.scopeId, sinceIso) as typeof r;
    } else {
      r = this.db
        .prepare(
          "SELECT SUM(cost_usd) AS cost FROM runs WHERE (project_id = ? OR project_path = ?) AND created_at >= ?",
        )
        .get(b.scopeId, projectPath, sinceIso) as typeof r;
    }
    return r.cost ?? 0;
  }

  /**
   * Runs of a scope created since `sinceIso` whose cost is not known: pending or running (not
   * settled), or ended without a cost. Keyed on cost_usd, not on cost_status, so that a run
   * closed by a process on an older build (cost_status left NULL) counts too, and not on
   * started_at, which a spawned child can lack (the write to running failed, an orphan swept
   * while pending). A run that provably launched nothing (the executor refused before spawning)
   * is closed with cost 0 by RunManager and is not in this set. Same scope rule as spentSince.
   */
  unknownCostSince(
    b: Pick<Budget, "scope" | "scopeId">,
    sinceIso: string,
    projectPath: string | null = null,
  ): UnknownCostRow[] {
    const unknown = "(status IN ('pending', 'running') OR cost_usd IS NULL) AND created_at >= ?";
    const select = "SELECT id, agent_id, status, phases_json, max_budget_usd FROM runs WHERE";
    let rows: Array<{
      id: string;
      agent_id: string;
      status: string;
      phases_json: string | null;
      max_budget_usd: number | null;
    }>;
    if (b.scope === "global") {
      rows = this.db.prepare(`${select} ${unknown} ORDER BY created_at`).all(sinceIso) as typeof rows;
    } else if (b.scope === "agent") {
      rows = this.db
        .prepare(`${select} agent_id = ? AND ${unknown} ORDER BY created_at`)
        .all(b.scopeId, sinceIso) as typeof rows;
    } else {
      rows = this.db
        .prepare(`${select} (project_id = ? OR project_path = ?) AND ${unknown} ORDER BY created_at`)
        .all(b.scopeId, projectPath, sinceIso) as typeof rows;
    }
    return rows.map((r) => {
      const running = r.status === "pending" || r.status === "running";
      // The cap stored at start (migration 26) is exact, whatever set it (agent, run_agent
      // override, resume budget). Older rows fall back to their phases; a run still going may
      // have a wrap-up phase ahead, so its recorded phases are not its whole cap.
      const startedCapUsd = positiveUsd(r.max_budget_usd)
        ? r.max_budget_usd
        : running
          ? null
          : phaseBudgetTotal(r.phases_json);
      return {
        id: r.id,
        agentId: r.agent_id,
        kind: running ? "running" : "unpriced",
        startedCapUsd,
      };
    });
  }

  /** Enabled schedules, with what decides their scope (agent and stored project). */
  enabledSchedules(): Array<{ id: string; name: string; agentId: string; projectId: string | null }> {
    return (
      this.db
        .prepare("SELECT id, name, agent_id, project_id FROM schedules WHERE enabled = 1 ORDER BY name")
        .all() as Array<{
        id: string;
        name: string;
        agent_id: string;
        project_id: string | null;
      }>
    ).map((r) => ({ id: r.id, name: r.name, agentId: r.agent_id, projectId: r.project_id }));
  }

  /** Pause these schedules (enabled = 0, next_run_at and a pending deferred fire cleared, as update_schedule enabled: false does). */
  pauseSchedules(ids: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE schedules SET enabled = 0, next_run_at = NULL, deferred_until = NULL, deferred_reason = NULL, updated_at = ? WHERE id = ? AND enabled = 1",
    );
    const now = new Date().toISOString();
    for (const id of ids) stmt.run(now, id);
  }
}
