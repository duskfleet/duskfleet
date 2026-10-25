/**
 * SQLite persistence for monthly budgets (migration 18): the rows, the spend they are compared
 * with (from `runs`) and the pause of the schedules of a scope whose hard stop was reached.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Budget, BudgetInput, BudgetScope } from "../orchestration/budget.js";

interface BudgetRow {
  id: string;
  scope: string;
  scope_id: string | null;
  amount_usd: number;
  warn_percent: number;
  hard_stop: number;
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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

  /** Create the budget of a scope, or replace the one it has (one budget per scope). Input already validated. */
  upsert(input: Required<BudgetInput>): Budget {
    const now = new Date().toISOString();
    const existing = this.find(input.scope, input.scopeId);
    if (existing) {
      this.db
        .prepare("UPDATE budgets SET amount_usd = ?, warn_percent = ?, hard_stop = ?, updated_at = ? WHERE id = ?")
        .run(input.amountUsd, input.warnPercent, input.hardStop ? 1 : 0, now, existing.id);
      return this.get(existing.id)!;
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO budgets (id, scope, scope_id, amount_usd, warn_percent, hard_stop, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.scope, input.scopeId, input.amountUsd, input.warnPercent, input.hardStop ? 1 : 0, now, now);
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
