/**
 * SQLite persistence for schedules, their firing log, and the scheduler lease
 * that makes sure only one process ticks at a time (the MCP server inside
 * Claude Desktop and a `duskfleet serve` under launchd may both be alive).
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Schedule, ScheduleFiring, ScheduleInput, ScheduleOutcome, SchedulePatch } from "../scheduler/types.js";
import type { Run } from "../observability/run.js";

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
  };
}

export class ScheduleRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, name").all() as unknown as ScheduleRow[]).map(rowToSchedule);
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  findByName(name: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE name = ?").get(name) as unknown as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  /** Enabled schedules whose next_run_at is at or before `now`. */
  due(nowIso: string): Schedule[] {
    return (
      this.db
        .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
        .all(nowIso) as unknown as ScheduleRow[]
    ).map(rowToSchedule);
  }

  insert(input: ScheduleInput & { nextRunAt: string | null }): Schedule {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO schedules (id, name, agent_id, project_id, prompt, model, cron, time_zone, enabled, created_at, updated_at, next_run_at,
           last_fired_at, last_outcome, last_error, last_run_id, fires, skips, on_failure, resume_budget_usd, noop_pattern)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?)`,
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
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !(k in map)) continue;
      sets.push(`${map[k]} = ?`);
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null));
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
    const rows = (this.db.prepare("SELECT * FROM schedules WHERE run_requested_at IS NOT NULL ORDER BY run_requested_at").all() as unknown as ScheduleRow[]).map(rowToSchedule);
    if (rows.length > 0) this.db.prepare("UPDATE schedules SET run_requested_at = NULL WHERE run_requested_at IS NOT NULL").run();
    return rows;
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  /** Record a firing attempt and advance the schedule. */
  recordFiring(id: string, outcome: ScheduleOutcome, runId: string | null, error: string | null, nextRunAt: string | null): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO schedule_firings (schedule_id, fired_at, outcome, run_id, error) VALUES (?, ?, ?, ?, ?)").run(id, now, outcome, runId, error);
    this.db
      .prepare(
        `UPDATE schedules SET last_fired_at = ?, last_outcome = ?, last_error = ?, last_run_id = COALESCE(?, last_run_id),
           fires = fires + ?, skips = skips + ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, outcome, error, runId, outcome === "started" || outcome === "resumed" ? 1 : 0, outcome === "started" || outcome === "resumed" ? 0 : 1, nextRunAt, now, id);
  }

  /** Ticks considered since `sinceIso`, by outcome. */
  firingCountsSince(scheduleId: string, sinceIso: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT outcome, COUNT(*) AS n FROM schedule_firings WHERE schedule_id = ? AND fired_at >= ? GROUP BY outcome")
      .all(scheduleId, sinceIso) as Array<{ outcome: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  }

  /** Finished-or-not runs a schedule started since `sinceIso`: just what the idle stats read. */
  runOutcomesSince(scheduleId: string, sinceIso: string): Array<{ status: Run["status"]; resultText: string | null; costUsd: number | null }> {
    return (
      this.db
        .prepare("SELECT status, result_text, cost_usd FROM runs WHERE schedule_id = ? AND created_at >= ?")
        .all(scheduleId, sinceIso) as Array<{ status: Run["status"]; result_text: string | null; cost_usd: number | null }>
    ).map((r) => ({ status: r.status, resultText: r.result_text, costUsd: r.cost_usd }));
  }

  firings(scheduleId: string, limit = 20): ScheduleFiring[] {
    return (
      this.db
        .prepare("SELECT id, schedule_id, fired_at, outcome, run_id, error FROM schedule_firings WHERE schedule_id = ? ORDER BY id DESC LIMIT ?")
        .all(scheduleId, limit) as Array<{ id: number; schedule_id: string; fired_at: string; outcome: string; run_id: string | null; error: string | null }>
    ).map((r) => ({ id: r.id, scheduleId: r.schedule_id, firedAt: r.fired_at, outcome: r.outcome as ScheduleOutcome, runId: r.run_id, error: r.error }));
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
    this.db.prepare("INSERT OR IGNORE INTO scheduler_lease (id, holder, expires_at) VALUES (1, ?, ?)").run(holder, expires);
    const r = this.db
      .prepare(
        "UPDATE scheduler_lease SET holder = ?, expires_at = ? WHERE id = 1 AND (holder = ? OR expires_at < ? OR (? AND holder NOT LIKE 'serve@%'))",
      )
      .run(holder, expires, holder, nowIso, preempt ? 1 : 0);
    return Number(r.changes) > 0;
  }

  releaseLease(holder: string): void {
    this.db.prepare("UPDATE scheduler_lease SET expires_at = ? WHERE id = 1 AND holder = ?").run(new Date(0).toISOString(), holder);
  }

  leaseInfo(): { holder: string; expiresAt: string } | null {
    const r = this.db.prepare("SELECT holder, expires_at FROM scheduler_lease WHERE id = 1").get() as { holder: string; expires_at: string } | undefined;
    return r ? { holder: r.holder, expiresAt: r.expires_at } : null;
  }
}
