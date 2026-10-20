/**
 * SQLite persistence for schedules, their firing log, and the scheduler lease
 * that makes sure only one process ticks at a time (the MCP server inside
 * Claude Desktop and a `duskfleet serve` under launchd may both be alive).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  RunOutcomes,
  Schedule,
  ScheduleFiring,
  ScheduleGate,
  ScheduleInput,
  ScheduleOutcome,
  SchedulePatch,
} from "../scheduler/types.js";
import { logger } from "../util/log.js";
import { NEEDS_REVIEW_SQL } from "./runs.js";

const log = logger("storage");

interface ScheduleRow {
  id: string;
  name: string;
  agent_id: string;
  project_id: string | null;
  prompt: string;
  model: string | null;
  cron: string;
  time_zone: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  last_fired_at: string | null;
  last_outcome: string | null;
  last_error: string | null;
  last_run_id: string | null;
  fires: number;
  skips: number;
  run_requested_at: string | null;
  on_failure: string | null;
  resume_budget_usd: number | null;
  noop_pattern: string | null;
  gate_json: string | null;
}

/**
 * A stored gate. One that cannot be read is returned as an `invalid` gate, never as null: null
 * means "no gate", and silently dropping a broken one would fire the full run on every tick,
 * the exact cost the gate is there to avoid. The scheduler records such a fire as an error.
 */
export function parseGate(json: string | null | undefined, scheduleName = "?"): ScheduleGate | null {
  if (!json) return null;
  let invalid: string;
  try {
    const v: unknown = JSON.parse(json);
    const g = v as ScheduleGate | null;
    if (
      g &&
      typeof g === "object" &&
      !Array.isArray(g) &&
      (typeof g.command === "string" || (g.agent && typeof g.agent === "object"))
    ) {
      return g;
    }
    invalid = "gate_json has neither command nor agent";
  } catch (err) {
    invalid = `gate_json is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  log.warn("unusable stored gate", { schedule: scheduleName, invalid });
  return { invalid };
}

function rowToSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    name: r.name,
    agentId: r.agent_id,
    projectId: r.project_id,
    prompt: r.prompt,
    model: r.model,
    cron: r.cron,
    timeZone: r.time_zone,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    nextRunAt: r.next_run_at,
    lastFiredAt: r.last_fired_at,
    lastOutcome: (r.last_outcome as ScheduleOutcome | null) ?? null,
    lastError: r.last_error,
    lastRunId: r.last_run_id,
    fires: r.fires,
    skips: r.skips,
    runRequestedAt: r.run_requested_at ?? null,
    onFailure: (r.on_failure as Schedule["onFailure"]) ?? null,
    resumeBudgetUsd: r.resume_budget_usd ?? null,
    noopPattern: r.noop_pattern ?? null,
    gate: parseGate(r.gate_json, r.name),
  };
}

export class ScheduleRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Schedule[] {
    return (
      this.db
        .prepare("SELECT * FROM schedules ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, name")
        .all() as unknown as ScheduleRow[]
    ).map(rowToSchedule);
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  findByName(name: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE name = ?").get(name) as unknown as
      | ScheduleRow
      | undefined;
    return row ? rowToSchedule(row) : null;
  }

  /** Enabled schedules whose next_run_at is at or before `now`. */
  due(nowIso: string): Schedule[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
        )
        .all(nowIso) as unknown as ScheduleRow[]
    ).map(rowToSchedule);
  }

  insert(input: ScheduleInput & { nextRunAt: string | null }): Schedule {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO schedules (id, name, agent_id, project_id, prompt, model, cron, time_zone, enabled, created_at, updated_at, next_run_at,
           last_fired_at, last_outcome, last_error, last_run_id, fires, skips, on_failure, resume_budget_usd, noop_pattern, gate_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.agentId,
        input.projectId ?? null,
        input.prompt,
        input.model ?? null,
        input.cron,
        input.timeZone ?? "Europe/London",
        input.enabled === false ? 0 : 1,
        now,
        now,
        input.nextRunAt,
        input.onFailure ?? null,
        input.resumeBudgetUsd ?? null,
        input.noopPattern ?? null,
        input.gate ? JSON.stringify(input.gate) : null,
      );
    return this.get(id)!;
  }

  update(id: string, patch: SchedulePatch & { nextRunAt?: string | null }): Schedule {
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [new Date().toISOString()];
    const map: Record<string, string> = {
      name: "name",
      agentId: "agent_id",
      projectId: "project_id",
      prompt: "prompt",
      model: "model",
      cron: "cron",
      timeZone: "time_zone",
      enabled: "enabled",
      nextRunAt: "next_run_at",
      onFailure: "on_failure",
      resumeBudgetUsd: "resume_budget_usd",
      noopPattern: "noop_pattern",
      gate: "gate_json",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !(k in map)) continue;
      sets.push(`${map[k]} = ?`);
      if (typeof v === "boolean") values.push(v ? 1 : 0);
      else if (typeof v === "object" && v !== null) values.push(JSON.stringify(v));
      else values.push(v as string | number | null);
    }
    values.push(id);
    this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id)!;
  }

  /**
   * Ask the ticking process to fire this schedule on its next tick (manual trigger from a
   * process without a RunManager, e.g. the dashboard). Idempotent: a second request before
   * the tick keeps the first timestamp. Returns null when the schedule does not exist.
   */
  requestRun(id: string): Schedule | null {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE schedules SET run_requested_at = COALESCE(run_requested_at, ?) WHERE id = ?").run(now, id);
    return this.get(id);
  }

  /** Schedules with a pending run request, cleared in the same call so a crash cannot loop on them. */
  takeRunRequests(): Schedule[] {
    const rows = (
      this.db
        .prepare("SELECT * FROM schedules WHERE run_requested_at IS NOT NULL ORDER BY run_requested_at")
        .all() as unknown as ScheduleRow[]
    ).map(rowToSchedule);
    if (rows.length > 0)
      this.db.prepare("UPDATE schedules SET run_requested_at = NULL WHERE run_requested_at IS NOT NULL").run();
    return rows;
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  /**
   * Claim a tick before a slow step (a gate): advance next_run_at now, so the schedule is no
   * longer due for anyone while the step runs. recordFiring writes the same value when it ends.
   */
  claimTick(id: string, nextRunAt: string | null): void {
    this.db
      .prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(nextRunAt, new Date().toISOString(), id);
  }

  /** Record a firing attempt and advance the schedule. `gate` is set when a gate ran on this tick. */
  recordFiring(
    id: string,
    outcome: ScheduleOutcome,
    runId: string | null,
    error: string | null,
    nextRunAt: string | null,
    gate: { runId: string | null; costUsd: number | null } | null = null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO schedule_firings (schedule_id, fired_at, outcome, run_id, error, gate_run_id, gate_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, now, outcome, runId, error, gate?.runId ?? null, gate ? (gate.costUsd ?? 0) : null);
    this.db
      .prepare(
        `UPDATE schedules SET last_fired_at = ?, last_outcome = ?, last_error = ?, last_run_id = COALESCE(?, last_run_id),
           fires = fires + ?, skips = skips + ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        now,
        outcome,
        error,
        runId,
        outcome === "started" || outcome === "resumed" ? 1 : 0,
        outcome === "started" || outcome === "resumed" ? 0 : 1,
        nextRunAt,
        now,
        id,
      );
  }

  /** Ticks considered since `sinceIso`, by outcome. */
  firingCountsSince(scheduleId: string, sinceIso: string): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT outcome, COUNT(*) AS n FROM schedule_firings WHERE schedule_id = ? AND fired_at >= ? GROUP BY outcome",
      )
      .all(scheduleId, sinceIso) as Array<{ outcome: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  }

  /**
   * What the idle stats read about the real runs (kind 'run'; gate runs are counted apart) a
   * schedule started since `sinceIso`: count and cost of all of them from SQL, and the head
   * (`textLimit` chars) of the final message of the completed ones that do not need review
   * (stored `review_reasons_json`), since only those can be no-ops: a run that hit a denial and
   * then says "nothing to do" was blocked, not idle.
   */
  runOutcomesSince(scheduleId: string, sinceIso: string, textLimit: number): RunOutcomes {
    const totals = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM runs WHERE schedule_id = ? AND created_at >= ? AND kind = 'run'",
      )
      .get(scheduleId, sinceIso) as { n: number; cost: number };
    const completed = (
      this.db
        .prepare(
          `SELECT substr(result_text, 1, ?) AS text, cost_usd FROM runs WHERE schedule_id = ? AND created_at >= ? AND kind = 'run' AND status = 'completed' AND result_text IS NOT NULL AND NOT ${NEEDS_REVIEW_SQL}`,
        )
        .all(textLimit, scheduleId, sinceIso) as Array<{ text: string; cost_usd: number | null }>
    ).map((r) => ({ resultText: r.text, costUsd: r.cost_usd }));
    return { runs: totals.n, costUsd: totals.cost, completed };
  }

  /** Gate checks since `sinceIso`: how many ran and what the gate agent runs cost. */
  gateSpendSince(scheduleId: string, sinceIso: string): { gateChecks: number; gateCostUsd: number } {
    const r = this.db
      .prepare(
        "SELECT COUNT(gate_cost_usd) AS n, COALESCE(SUM(gate_cost_usd), 0) AS cost FROM schedule_firings WHERE schedule_id = ? AND fired_at >= ?",
      )
      .get(scheduleId, sinceIso) as { n: number; cost: number };
    return { gateChecks: r.n, gateCostUsd: r.cost };
  }

  firings(scheduleId: string, limit = 20): ScheduleFiring[] {
    return (
      this.db
        .prepare(
          "SELECT id, schedule_id, fired_at, outcome, run_id, error, gate_run_id, gate_cost_usd FROM schedule_firings WHERE schedule_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(scheduleId, limit) as Array<{
        id: number;
        schedule_id: string;
        fired_at: string;
        outcome: string;
        run_id: string | null;
        error: string | null;
        gate_run_id: string | null;
        gate_cost_usd: number | null;
      }>
    ).map((r) => ({
      id: r.id,
      scheduleId: r.schedule_id,
      firedAt: r.fired_at,
      outcome: r.outcome as ScheduleOutcome,
      runId: r.run_id,
      error: r.error,
      gateRunId: r.gate_run_id ?? null,
      gateCostUsd: r.gate_cost_usd ?? null,
    }));
  }

  /** Ticks since `sinceIso` across every schedule: how many started a run (started + resumed) and how many were skipped busy. */
  firingTotals(sinceIso: string): { started: number; skippedBusy: number } {
    const r = this.db
      .prepare(
        `SELECT SUM(outcome IN ('started', 'resumed')) AS started, SUM(outcome = 'skipped_busy') AS skipped_busy
         FROM schedule_firings WHERE fired_at >= ?`,
      )
      .get(sinceIso) as { started: number | null; skipped_busy: number | null };
    return { started: r.started ?? 0, skippedBusy: r.skipped_busy ?? 0 };
  }

  // ---- lease ---------------------------------------------------------------

  /**
   * Try to take or renew the single scheduler lease for `ttlMs`. Returns true when
   * this holder owns it. Another live holder keeps it until its lease expires,
   * unless `preempt` is set (the `serve` role): then it is also taken from a live
   * holder of any other role, so an MCP server a host keeps alive with stale code
   * cannot out-tick the installed service. The displaced holder's next renewal
   * fails (its `holder = ?` clause no longer matches) and it stands by.
   */
  acquireLease(holder: string, ttlMs: number, preempt = false): boolean {
    const now = Date.now();
    const expires = new Date(now + ttlMs).toISOString();
    const nowIso = new Date(now).toISOString();
    this.db
      .prepare("INSERT OR IGNORE INTO scheduler_lease (id, holder, expires_at) VALUES (1, ?, ?)")
      .run(holder, expires);
    const r = this.db
      .prepare(
        "UPDATE scheduler_lease SET holder = ?, expires_at = ? WHERE id = 1 AND (holder = ? OR expires_at < ? OR (? AND holder NOT LIKE 'serve@%'))",
      )
      .run(holder, expires, holder, nowIso, preempt ? 1 : 0);
    return Number(r.changes) > 0;
  }

  releaseLease(holder: string): void {
    this.db
      .prepare("UPDATE scheduler_lease SET expires_at = ? WHERE id = 1 AND holder = ?")
      .run(new Date(0).toISOString(), holder);
  }

  leaseInfo(): { holder: string; expiresAt: string } | null {
    const r = this.db.prepare("SELECT holder, expires_at FROM scheduler_lease WHERE id = 1").get() as
      | { holder: string; expires_at: string }
      | undefined;
    return r ? { holder: r.holder, expiresAt: r.expires_at } : null;
  }
}
