/**
 * SQLite persistence for schedules, their firing log, and the scheduler lease
 * that makes sure only one process ticks at a time (the MCP server inside
 * Claude Desktop and a `duskfleet serve` under launchd may both be alive).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CatchUpPolicy,
  type ConcurrencyPolicy,
  DEFAULT_CATCH_UP_POLICY,
  DEFAULT_CONCURRENCY_POLICY,
  DEFAULT_TRIGGER_KIND,
  type RunOutcomes,
  type Schedule,
  type ScheduleFiring,
  type ScheduleGate,
  type ScheduleInput,
  type ScheduleOutcome,
  type SchedulePatch,
  type SchedulerPause,
  type TriggerKind,
} from "../scheduler/types.js";
import { logger } from "../util/log.js";
import { NEEDS_REVIEW_SQL } from "./runs.js";

const log = logger("storage");

/** No stored review reason other than `empty_run`: such a completed run may count as a no-op. */
const NOOP_ELIGIBLE_SQL = `NOT EXISTS (SELECT 1 FROM json_each(COALESCE(review_reasons_json, '[]')) WHERE value <> 'empty_run')`;

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
  concurrency_policy: string | null;
  catch_up_policy: string | null;
  trigger_kind: string | null;
  paused_reason: string | null;
  auto_paused_at: string | null;
  deferred_until: string | null;
  deferred_reason: string | null;
}

/** One ended run of a schedule as the auto-pause streak reads it (`ScheduleRepository.recentEndedRuns`). */
export interface EndedRunFacts {
  id: string;
  /** Completed with 0 tool calls. */
  empty: boolean;
  /** Stored review reasons are not empty. */
  needsReview: boolean;
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
    concurrencyPolicy: (r.concurrency_policy as ConcurrencyPolicy | null) ?? DEFAULT_CONCURRENCY_POLICY,
    catchUpPolicy: (r.catch_up_policy as CatchUpPolicy | null) ?? DEFAULT_CATCH_UP_POLICY,
    triggerKind: (r.trigger_kind as TriggerKind | null) ?? DEFAULT_TRIGGER_KIND,
    pausedReason: r.paused_reason ?? null,
    autoPausedAt: r.auto_paused_at ?? null,
    deferredUntil: r.deferred_until ?? null,
    deferredReason: r.deferred_reason ?? null,
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

  /** Enabled cron schedules (trigger_kind 'cron') whose next_run_at is at or before `now`. */
  due(nowIso: string): Schedule[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM schedules WHERE enabled = 1 AND trigger_kind = 'cron' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
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
           last_fired_at, last_outcome, last_error, last_run_id, fires, skips, on_failure, resume_budget_usd, noop_pattern, gate_json,
           concurrency_policy, catch_up_policy, trigger_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.concurrencyPolicy ?? DEFAULT_CONCURRENCY_POLICY,
        input.catchUpPolicy ?? DEFAULT_CATCH_UP_POLICY,
        input.triggerKind ?? DEFAULT_TRIGGER_KIND,
      );
    return this.get(id)!;
  }

  update(id: string, patch: SchedulePatch & { nextRunAt?: string | null; pausedReason?: string | null }): Schedule {
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
      concurrencyPolicy: "concurrency_policy",
      catchUpPolicy: "catch_up_policy",
      triggerKind: "trigger_kind",
      pausedReason: "paused_reason",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !(k in map)) continue;
      sets.push(`${map[k]} = ?`);
      if (typeof v === "boolean") values.push(v ? 1 : 0);
      else if (typeof v === "object" && v !== null) values.push(JSON.stringify(v));
      else values.push(v as string | number | null);
    }
    // A pause drops a pending deferred fire: it is a scheduled fire, not a manual request.
    if (patch.enabled === false) sets.push("deferred_until = NULL", "deferred_reason = NULL");
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

  /** Schedules with a pending deferred fire (`scheduler.defer_busy`), oldest deadline first. */
  deferred(): Schedule[] {
    return (
      this.db
        .prepare("SELECT * FROM schedules WHERE deferred_until IS NOT NULL ORDER BY deferred_until")
        .all() as unknown as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** Keep one pending fire for this schedule until `until`; a second call replaces the first (one per schedule). */
  defer(id: string, until: string, reason: string): void {
    this.db
      .prepare("UPDATE schedules SET deferred_until = ?, deferred_reason = ?, updated_at = ? WHERE id = ?")
      .run(until, reason, new Date().toISOString(), id);
  }

  /**
   * Put a pending deferred fire back after a retry that was busy again, only if nothing is pending
   * now: a fresher pending recorded meanwhile (the due loop deferring the next occurrence while
   * this retry's gate ran) wins over the stale one. Never onto a paused schedule: a pause during the
   * retry's gate cleared the pending, and a paused schedule never starts from one. True when it was
   * put back.
   */
  restoreDeferred(id: string, until: string, reason: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE schedules SET deferred_until = ?, deferred_reason = ?, updated_at = ? WHERE id = ? AND deferred_until IS NULL AND enabled = 1",
      )
      .run(until, reason, new Date().toISOString(), id);
    return Number(r.changes) > 0;
  }

  /**
   * A firing row that only carries a gate's spend, leaving the schedule row untouched: a deferred
   * retry whose gate ran but whose run was refused busy afterwards. Keeps gateSpendSince accurate
   * without moving next_run_at or the last outcome.
   */
  recordGateSpend(
    id: string,
    outcome: ScheduleOutcome,
    error: string | null,
    gate: { runId: string | null; costUsd: number | null },
  ): void {
    this.db
      .prepare(
        "INSERT INTO schedule_firings (schedule_id, fired_at, outcome, run_id, error, gate_run_id, gate_cost_usd) VALUES (?, ?, ?, NULL, ?, ?, ?)",
      )
      .run(id, new Date().toISOString(), outcome, error, gate.runId, gate.costUsd ?? 0);
  }

  /**
   * Compare-and-set take of a pending deferred fire: clear it only if it still holds the deadline
   * this process read. True when this call took it (then retry, expire or drop it); false when
   * someone else took or replaced it meanwhile.
   */
  takeDeferred(id: string, expected: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE schedules SET deferred_until = NULL, deferred_reason = NULL, updated_at = ? WHERE id = ? AND deferred_until = ?",
      )
      .run(new Date().toISOString(), id, expected);
    return Number(r.changes) > 0;
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  /**
   * Compare-and-set claim of a due tick: advance next_run_at only if it still holds the value
   * this process read (`expected`). True when this call claimed the tick; false when someone
   * else (another process that took the lease, an edit) moved it first: then do not fire.
   * The lease decides who ticks, this makes a double fire impossible even if it changes hands
   * between `due()` and the fire.
   */
  claimDue(id: string, expected: string | null, nextRunAt: string | null): boolean {
    const r = this.db
      .prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at IS ?")
      .run(nextRunAt, new Date().toISOString(), id, expected);
    return Number(r.changes) > 0;
  }

  /**
   * Claim a manual fire's tick before a slow step (a gate): advance next_run_at now, so the
   * schedule is no longer due for anyone while the step runs. recordFiring writes the same value
   * when it ends. Scheduled fires are claimed earlier, by claimDue.
   */
  claimTick(id: string, nextRunAt: string | null): void {
    this.db
      .prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(nextRunAt, new Date().toISOString(), id);
  }

  /**
   * Record a firing attempt and advance the schedule. `gate` is set when a gate ran on this tick.
   * `deferred` counts as neither a fire nor a skip (the row that settles it does).
   *
   * `settles` says which pending deferred fire a start settles: `"any"` (a manual start: the work
   * any pending was waiting for has just begun), a deadline (a retry: only the pending it took, if
   * it still holds that deadline), or null (none). Never a blanket clear on every start: while a
   * retry's gate ran, the due loop may have recorded a fresher pending for the next occurrence,
   * and that one must survive the retry's start. Ignored for outcomes other than started/resumed.
   */
  recordFiring(
    id: string,
    outcome: ScheduleOutcome,
    runId: string | null,
    error: string | null,
    nextRunAt: string | null,
    gate: { runId: string | null; costUsd: number | null } | null = null,
    settles: "any" | string | null = null,
  ): void {
    const now = new Date().toISOString();
    const started = outcome === "started" || outcome === "resumed";
    const settleAny = started && settles === "any" ? 1 : 0;
    // A deadline that matches nothing when this start settles no specific pending.
    const settleUntil = started && settles !== null && settles !== "any" ? settles : null;
    const settleSome = settleAny === 1 || settleUntil !== null ? 1 : 0;
    this.db
      .prepare(
        "INSERT INTO schedule_firings (schedule_id, fired_at, outcome, run_id, error, gate_run_id, gate_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, now, outcome, runId, error, gate?.runId ?? null, gate ? (gate.costUsd ?? 0) : null);
    this.db
      .prepare(
        `UPDATE schedules SET last_fired_at = ?, last_outcome = ?, last_error = ?, last_run_id = COALESCE(?, last_run_id),
           fires = fires + ?, skips = skips + ?, next_run_at = ?, updated_at = ?,
           deferred_reason = CASE WHEN ? AND (? OR deferred_until IS ?) THEN NULL ELSE deferred_reason END,
           deferred_until = CASE WHEN ? AND (? OR deferred_until IS ?) THEN NULL ELSE deferred_until END
         WHERE id = ?`,
      )
      .run(
        now,
        outcome,
        error,
        runId,
        started ? 1 : 0,
        started || outcome === "deferred" ? 0 : 1,
        nextRunAt,
        now,
        settleSome,
        settleAny,
        settleUntil,
        settleSome,
        settleAny,
        settleUntil,
        id,
      );
  }

  /**
   * Pause a schedule on the scheduler's own decision and say why. Compare-and-set on `enabled`:
   * a schedule paused (or deleted) by someone else meanwhile is left alone. True when it paused.
   */
  autoPause(id: string, reason: string, nowIso: string = new Date().toISOString()): boolean {
    const r = this.db
      .prepare(
        "UPDATE schedules SET enabled = 0, next_run_at = NULL, paused_reason = ?, auto_paused_at = ?, updated_at = ?, deferred_until = NULL, deferred_reason = NULL WHERE id = ? AND enabled = 1",
      )
      .run(reason, nowIso, nowIso, id);
    return Number(r.changes) > 0;
  }

  /**
   * The last `limit` ended real runs (kind 'run'; gate runs are not the schedule's work) the
   * schedule started, newest first, created after `sinceIso` when given. Running runs are left
   * out: they have not ended yet.
   */
  recentEndedRuns(scheduleId: string, sinceIso: string | null, limit: number): EndedRunFacts[] {
    const rows = this.db
      .prepare(
        `SELECT id, status = 'completed' AND COALESCE(tool_calls, 0) = 0 AS empty, ${NEEDS_REVIEW_SQL} AS needs_review
         FROM runs WHERE schedule_id = ? AND kind = 'run' AND status IN ('completed', 'failed', 'cancelled', 'timed_out')
           AND (? IS NULL OR created_at > ?)
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scheduleId, sinceIso, sinceIso, limit) as Array<{ id: string; empty: number; needs_review: number }>;
    return rows.map((r) => ({ id: r.id, empty: r.empty === 1, needsReview: r.needs_review === 1 }));
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
   * then says "nothing to do" was blocked, not idle. `empty_run` alone does not exclude a run:
   * a text-only "nothing to do" answer is the typical no-op.
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
          `SELECT substr(result_text, 1, ?) AS text, cost_usd FROM runs WHERE schedule_id = ? AND created_at >= ? AND kind = 'run' AND status = 'completed' AND result_text IS NOT NULL AND ${NOOP_ELIGIBLE_SQL}`,
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

  // ---- scheduler pause -----------------------------------------------------

  /** Pause the whole scheduler until `untilIso` (replaces any earlier pause). */
  setPause(untilIso: string, reason: string | null, pausedBy: string | null, nowIso = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO scheduler_pause (id, paused_until, paused_at, reason, paused_by) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET paused_until = excluded.paused_until, paused_at = excluded.paused_at,
           reason = excluded.reason, paused_by = excluded.paused_by`,
      )
      .run(untilIso, nowIso, reason, pausedBy);
  }

  /** Lift the pause. True when there was one stored (expired or not). */
  clearPause(): boolean {
    return Number(this.db.prepare("DELETE FROM scheduler_pause WHERE id = 1").run().changes) > 0;
  }

  /** The pause in force at `nowIso`, or null (none stored, or already over). */
  activePause(nowIso: string = new Date().toISOString()): SchedulerPause | null {
    const r = this.db
      .prepare(
        "SELECT paused_until, paused_at, reason, paused_by FROM scheduler_pause WHERE id = 1 AND paused_until > ?",
      )
      .get(nowIso) as
      | { paused_until: string; paused_at: string; reason: string | null; paused_by: string | null }
      | undefined;
    return r ? { pausedUntil: r.paused_until, pausedAt: r.paused_at, reason: r.reason, pausedBy: r.paused_by } : null;
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
