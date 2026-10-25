/**
 * In-process scheduler. One tick every `tickMs`: take the lease, re-read config
 * (kill switch), fire every due schedule through RunManager, advance next_run_at.
 *
 * Policies, deliberately simple:
 *  - No catch-up (`catch_up_policy: skip_missed`, the only implemented value). Ticks
 *    missed while nobody was running are not replayed: the schedule fires once when
 *    next considered and its next_run_at is recomputed from now. Hourly jobs do not want a burst.
 *  - Busy is never a queue (`concurrency_policy: skip_if_active`, the only value). RunManager's
 *    per-agent / per-project guards throw BusyError. With `scheduler.defer_busy` (default) a
 *    scheduled fire is recorded `deferred` and kept as ONE pending fire per schedule
 *    (`deferred_until` = the next cron occurrence): every tick retries it, a retry that is busy
 *    again writes nothing, a start settles it, a pause drops it, and once the next occurrence
 *    comes it is dropped as `skipped_busy` and the normal fire takes over. Without it, or for a
 *    manual fire (the caller is there to retry), the firing is `skipped_busy`.
 *  - An agent over its daily cap (max_daily_runs / max_daily_cost_usd, UTC day) is a
 *    skip too, recorded as `skipped_daily_cap`.
 *  - A spent hard-stop budget (global / agent / project, UTC month) is `skipped_budget`; the
 *    refusal pauses every schedule of that scope (RunManager), so they stay off until resumed.
 *  - Only one process ticks: the SQLite lease (see ScheduleRepository) is renewed
 *    every tick and expires after 3 ticks without renewal. The `serve` role takes
 *    it from any other holder (`mcp`, `cli`, role-less) on its first tick: the
 *    installed service runs the latest build, an MCP server a host keeps alive
 *    may not, and it must never hold the lease for days.
 *  - The lease decides who ticks; a compare-and-set on next_run_at (claimDue) decides who
 *    fires a due tick, so a lease handover in the middle of a tick cannot fire it twice.
 *  - A process without a RunManager (the dashboard) triggers a schedule by setting
 *    `run_requested_at`; the lease holder fires it on its next tick, paused or not.
 *  - Auto-pause: before a scheduled (not manual) fire, a schedule whose last
 *    `scheduler.auto_pause_after` ended runs were all empty (0 tool calls) or needs review
 *    is paused instead, with the reason stored on the row (`auto_paused` firing).
 *  - `pause` (MCP `pause_scheduler`): a pause of the whole scheduler until an instant, stored in
 *    the database and read every tick. The lease holder keeps ticking (lease, orphan sweep) but
 *    fires nothing; what came due meanwhile fires once when the pause ends (no catch-up).
 *  - The lease holder also sweeps orphaned runs (owner process gone) at most once a
 *    minute, so a crashed process's runs close without waiting for the next start.
 */

import type { Run } from "../observability/run.js";
import { BudgetError } from "../orchestration/budget.js";
import { BusyError } from "../orchestration/busy.js";
import { DailyCapError } from "../orchestration/daily-cap.js";
import type { RunManager } from "../orchestration/run-manager.js";
import type { ScheduleRepository } from "../storage/schedules.js";
import { logger } from "../util/log.js";
import {
  autoPauseReason,
  createSchedule,
  nextRunAtFor,
  parseHolder,
  processIdentity,
  type ScheduleRunState,
  type SchedulerRole,
  scheduleRunState,
  updateSchedule,
} from "./crud.js";
import { evaluateGate } from "./gate.js";
import { type IdleStats, scheduleIdleStats } from "./idle.js";
import {
  MAX_SCHEDULER_PAUSE_MINUTES,
  type Schedule,
  type ScheduleInput,
  type ScheduleOutcome,
  type SchedulePatch,
  type SchedulerPause,
} from "./types.js";

export interface FireResult {
  outcome: ScheduleOutcome;
  runId: string | null;
  /** Error, busy message, or the gate's reason for a skip. */
  error: string | null;
  /** Set when an agent gate ran on this fire. */
  gateRunId?: string | null;
  gateCostUsd?: number | null;
}

const log = logger("scheduler");

const ORPHAN_SWEEP_MS = 60_000;

export interface SchedulerOptions {
  tickMs?: number;
  /** Identifies this process in the lease; defaults to `<role>@host:pid`. */
  holder?: string;
  /** What kind of process this is (`serve`, `mcp`, `cli`); the dashboard shows it as the lease holder. */
  role?: SchedulerRole;
  now?: () => Date;
}

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  holder: string;
  leaseHeldByThisProcess: boolean;
  lease: { holder: string; expiresAt: string } | null;
  tickMs: number;
  lastTickAt: string | null;
  /** The pause set with `pause_scheduler` while it is in force, else null. */
  pause: SchedulerPause | null;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly tickMs: number;
  private readonly holder: string;
  private readonly now: () => Date;
  private lastTickAt: string | null = null;
  private leaseHeld = false;
  private ticking = false;
  private lastSweepMs = -Infinity;
  /** Schedules whose gate is being evaluated right now (at most one gate per schedule). */
  private readonly gating = new Set<string>();
  /** Gated fires started by a tick that run on in the background (see dispatch). */
  private readonly background = new Set<Promise<FireResult>>();
  /** `serve` takes the lease from `mcp` / `cli` / role-less holders instead of waiting for it to expire. */
  private readonly preempts: boolean;

  constructor(
    private readonly repo: ScheduleRepository,
    private readonly runs: RunManager,
    options: SchedulerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 30_000;
    this.holder = options.holder ?? processIdentity(options.role ?? "unknown");
    this.preempts = parseHolder(this.holder).role === "serve";
    this.now = options.now ?? (() => new Date());
  }

  // ---- CRUD (validation lives in crud.ts so MCP, CLI, dashboard and tests share it) ----

  create(input: ScheduleInput): Schedule {
    // Fresh config: agent / project edits and scheduler.allow_command_gates apply without restart.
    // A failed reload refuses command gates (the kept config may be stale), see commandGateRefusal.
    const config = this.runs.reloadConfig();
    const created = createSchedule(this.repo, config, input, this.now(), this.runs.configReloadError);
    log.info("schedule created", {
      id: created.id,
      name: created.name,
      cron: created.cron,
      tz: created.timeZone,
      next: created.nextRunAt,
    });
    return created;
  }

  update(id: string, patch: SchedulePatch): Schedule {
    const config = this.runs.reloadConfig();
    const updated = updateSchedule(this.repo, config, id, patch, this.now(), this.runs.configReloadError);
    log.info("schedule updated", { id, name: updated.name, enabled: updated.enabled, next: updated.nextRunAt });
    return updated;
  }

  delete(id: string): boolean {
    return this.repo.delete(id);
  }

  list(): Schedule[] {
    return this.repo.list();
  }

  /** Schedules with the state of the run each last started, what their next fire does (see scheduleRunState) and their 7-day idle cost. */
  listWithLastRun(): Array<Schedule & ScheduleRunState & { idle7d: IdleStats }> {
    const now = this.now();
    return this.repo.list().map((s) => this.withLastRun(s, now));
  }

  /** One schedule with its run state (lastRun, effectiveOnFailure, onFailureSource, willResumeRunId, effectiveProjectId) and idle7d. */
  withLastRun(s: Schedule, now: Date = this.now()): Schedule & ScheduleRunState & { idle7d: IdleStats } {
    const { lastRun, effectiveOnFailure, onFailureSource, willResumeRunId, effectiveProjectId } = this.runState(s);
    const idle7d = scheduleIdleStats(this.repo, s, this.runs.config.scheduler.noopPattern, now);
    return { ...s, lastRun, effectiveOnFailure, onFailureSource, willResumeRunId, effectiveProjectId, idle7d };
  }

  /** Idle stats of one schedule over the last `days`. */
  idleStats(s: Schedule, days = 7): IdleStats {
    return scheduleIdleStats(this.repo, s, this.runs.config.scheduler.noopPattern, this.now(), days);
  }

  get(id: string): Schedule | null {
    return this.repo.get(id);
  }

  firings(id: string, limit?: number) {
    return this.repo.firings(id, limit);
  }

  /**
   * Ask whichever process holds the lease to fire this schedule on its next tick (see
   * `ScheduleRepository.requestRun`). Accepts the id or the unique name. Unlike `fireNow`
   * it spawns nothing here, so a short-lived caller (CLI, git hook) can return at once.
   */
  requestRun(idOrName: string): Schedule | null {
    const s = this.repo.get(idOrName) ?? this.repo.findByName(idOrName);
    return s ? this.repo.requestRun(s.id) : null;
  }

  /** Fire a schedule right now, outside its cron (manual trigger). Returns the outcome. */
  async fireNow(id: string, options: { skipGate?: boolean } = {}): Promise<FireResult> {
    const s = this.repo.get(id);
    if (!s) throw new Error(`schedule not found: ${id}`);
    return this.fire(s, true, options.skipGate ?? false);
  }

  // ---- loop ----------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
    log.info("scheduler started", { holder: this.holder, tickMs: this.tickMs });
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.leaseHeld) this.repo.releaseLease(this.holder);
    this.leaseHeld = false;
  }

  status(): SchedulerStatus {
    return {
      enabled: this.runs.config.scheduler.enabled,
      running: this.timer !== null,
      holder: this.holder,
      leaseHeldByThisProcess: this.leaseHeld,
      lease: this.repo.leaseInfo(),
      tickMs: this.tickMs,
      lastTickAt: this.lastTickAt,
      pause: this.repo.activePause(this.now().toISOString()),
    };
  }

  /**
   * Pause the whole scheduler for `minutes` (1 to MAX_SCHEDULER_PAUSE_MINUTES), replacing any
   * earlier pause; `minutes` 0 lifts it. Stored in the database, so it holds for whichever
   * process ticks, and ends on its own. Returns the pause in force afterwards (null when lifted).
   */
  pause(minutes: number, reason: string | null = null): SchedulerPause | null {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_SCHEDULER_PAUSE_MINUTES) {
      throw new Error(
        `minutes must be an integer from 0 (resume) to ${MAX_SCHEDULER_PAUSE_MINUTES} (7 days); for longer, set scheduler.enabled: false`,
      );
    }
    if (minutes === 0) {
      if (this.repo.clearPause()) log.info("scheduler pause lifted", { by: this.holder });
      return null;
    }
    const now = this.now();
    const until = new Date(now.getTime() + minutes * 60_000).toISOString();
    this.repo.setPause(until, reason?.trim() || null, this.holder, now.toISOString());
    log.info("scheduler paused", { until, reason, by: this.holder });
    return this.repo.activePause(now.toISOString());
  }

  /** One pass. Public so tests can drive it without timers. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const config = this.runs.reloadConfig(); // kill switch and agent/project edits apply without restart
      this.lastTickAt = this.now().toISOString();
      if (!config.scheduler.enabled) {
        if (this.leaseHeld) this.repo.releaseLease(this.holder);
        this.leaseHeld = false;
        return;
      }
      const hadLease = this.leaseHeld;
      this.leaseHeld = this.repo.acquireLease(this.holder, this.tickMs * 3, this.preempts);
      if (!this.leaseHeld) {
        if (hadLease) log.info("lease lost", { holder: this.holder, to: this.repo.leaseInfo()?.holder ?? null });
        return;
      }
      if (!hadLease) log.info("lease acquired", { holder: this.holder });

      const nowMs = this.now().getTime();
      if (nowMs - this.lastSweepMs >= ORPHAN_SWEEP_MS) {
        // Own try: a failed sweep (e.g. SQLITE_BUSY) must not skip run-now requests and due
        // schedules, and is retried on the next tick instead of a minute later.
        try {
          this.runs.recoverOrphans();
          this.lastSweepMs = nowMs;
        } catch (err) {
          log.error("orphan sweep failed", { err: err instanceof Error ? err.message : String(err) });
        }
      }

      // pause_scheduler: keep the lease and the sweep, fire nothing. Due ticks and run-now
      // requests stay where they are and fire once on the first tick after the pause.
      if (this.repo.activePause(this.now().toISOString())) return;

      // Manual "run now" requests (dashboard) first: they fire even when paused, like fireNow.
      for (const s of this.repo.takeRunRequests()) {
        log.info("run requested", { schedule: s.name, requestedAt: s.runRequestedAt });
        await this.dispatch(s, true);
      }
      // Deferred busy fires next, before the due ones: a pending whose next occurrence has come
      // is settled here first (skipped_busy), so the due loop below fires that occurrence normally.
      await this.retryDeferred(config.scheduler.deferBusy);
      for (const s of this.repo.due(this.now().toISOString())) {
        await this.dispatch(s, false);
      }
    } catch (err) {
      log.error("tick failed", { err: err instanceof Error ? err.message : String(err) });
    } finally {
      this.ticking = false;
    }
  }

  /** Resolves once the gated fires started by earlier ticks have finished (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Fire from a tick. A gated schedule fires in the background: its gate can take minutes
   * (a command up to 600 s, an agent up to its timeout), and the tick must go on renewing the
   * lease and serving other due schedules and run-now requests meanwhile. The fire claims its
   * tick (next_run_at) before the gate starts, so no later tick, here or in another process
   * that took the lease over, fires it again.
   *
   * A scheduled (non-manual) fire is claimed first with a compare-and-set on the next_run_at
   * this tick read: if another process fired it meanwhile (the lease changed hands between
   * `due()` and here), the claim fails and this tick leaves it alone, recording nothing.
   * A retry of a deferred fire (`retry`) was claimed by `retryDeferred` (takeDeferred) instead.
   */
  private async dispatch(s: Schedule, manual: boolean, retry = false): Promise<void> {
    if (!manual && !retry) {
      const next = s.enabled ? this.computeNext(s.cron, s.timeZone) : null;
      if (!this.repo.claimDue(s.id, s.nextRunAt, next)) {
        log.info("tick already claimed elsewhere; not firing", { schedule: s.name, nextRunAt: s.nextRunAt });
        return;
      }
    }
    if (!s.gate) {
      await this.fire(s, manual, false, retry);
      return;
    }
    const p: Promise<FireResult> = this.fire(s, manual, false, retry)
      .catch((err): FireResult => {
        const message = err instanceof Error ? err.message : String(err);
        log.error("gated fire failed", { schedule: s.name, err: message });
        return { outcome: "error", runId: null, error: message };
      })
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /**
   * Take every pending deferred fire (compare-and-set, so a lease handover cannot retry it twice)
   * and settle or retry it: paused schedule = dropped; next occurrence reached (or `defer_busy`
   * turned off) = `skipped_busy` with the original tick's message; otherwise fired again as a
   * scheduled fire that keeps next_run_at, and put back by `fire` if it is still busy.
   */
  private async retryDeferred(deferBusy: boolean): Promise<void> {
    const nowIso = this.now().toISOString();
    for (const s of this.repo.deferred()) {
      const until = s.deferredUntil;
      if (!until || !this.repo.takeDeferred(s.id, until)) continue;
      if (!s.enabled) {
        log.info("deferred fire dropped: schedule paused", { schedule: s.name, pausedReason: s.pausedReason });
        continue;
      }
      if (until <= nowIso || !deferBusy) {
        this.repo.recordFiring(s.id, "skipped_busy", null, s.deferredReason, s.nextRunAt);
        log.info("deferred fire expired", { schedule: s.name, deferredUntil: until, deferBusy });
        continue;
      }
      await this.dispatch(s, false, true);
    }
  }

  /**
   * `retry` = a pending deferred fire tried again (see retryDeferred): next_run_at is left as it
   * is (the occurrence it waits for has not come yet), and still busy puts it back, writing no row
   * (only a spend row when its gate ran).
   */
  private async fire(s: Schedule, manual: boolean, skipGate = false, retry = false): Promise<FireResult> {
    const nextRunAt = retry ? null : s.enabled ? this.computeNext(s.cron, s.timeZone) : null;
    // A retry keeps next_run_at, re-read right before each write and never taken from the snapshot:
    // while its gate ran the due loop may have claimed the occurrence and moved next_run_at on, and
    // writing the stale value back would make that occurrence due a second time.
    const nextAt = (): string | null => (retry ? (this.repo.get(s.id)?.nextRunAt ?? null) : nextRunAt);
    if (!s.enabled && !manual) {
      this.repo.recordFiring(s.id, "skipped_disabled", null, null, nextAt());
      return { outcome: "skipped_disabled", runId: null, error: null };
    }
    if (!manual) {
      const reason = autoPauseReason(this.repo, s, this.runs.config.scheduler.autoPauseAfter);
      if (reason && this.repo.autoPause(s.id, reason, this.now().toISOString())) {
        this.repo.recordFiring(s.id, "auto_paused", null, reason, null);
        log.warn("schedule auto-paused", { schedule: s.name, reason });
        return { outcome: "auto_paused", runId: null, error: reason };
      }
    }
    let gateSpend: { runId: string | null; costUsd: number | null } | null = null;
    try {
      const resumable = this.resumeCandidate(s);
      let resumeError: string | null = null;
      if (resumable) {
        const input: Parameters<RunManager["resumeRun"]>[0] = { runId: resumable.id, scheduleId: s.id };
        if (s.resumeBudgetUsd !== null) input.budgetUsd = s.resumeBudgetUsd;
        try {
          const run = await this.runs.resumeRun(input);
          this.repo.recordFiring(s.id, "resumed", run.id, null, nextAt());
          log.info("schedule fired as a resume", {
            schedule: s.name,
            runId: run.id,
            resumedFrom: resumable.id,
            manual,
          });
          return { outcome: "resumed", runId: run.id, error: null };
        } catch (err) {
          // Busy is a skip: the resume is tried again on the next tick. Anything else (agent
          // deleted, project gone, already resumed by another process) would come back on every
          // tick, so this fire starts fresh instead and last_run_id moves past the failed run.
          // A daily cap is a skip too: starting fresh would hit the same cap.
          if (err instanceof BusyError || err instanceof DailyCapError || err instanceof BudgetError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          resumeError = message;
          log.warn("resume refused; starting fresh", { schedule: s.name, resumedFrom: resumable.id, message });
        }
      }
      if (s.gate && !skipGate) {
        if (this.gating.has(s.id))
          throw new BusyError(`schedule "${s.name}" busy: its gate from an earlier fire is still running`);
        // Busy first: a gate costs time (and, for an agent gate, money) only when the run could start.
        const busy = this.runs.busyReason({ agentId: s.agentId, projectId: s.projectId });
        if (busy) throw new BusyError(busy);
        const capped = this.runs.dailyCapReason(s.agentId);
        if (capped) throw new DailyCapError(capped);
        const overBudget = this.runs.budgetReason({ agentId: s.agentId, projectId: s.projectId });
        if (overBudget) throw new BudgetError(overBudget);
        // Claim the tick before the gate runs: next_run_at moves on now, so neither a later tick
        // nor another process that takes the lease during a long gate sees it as still due.
        // A scheduled fire was already claimed by dispatch (claimDue); a manual one is claimed here.
        if (manual) this.repo.claimTick(s.id, nextRunAt);
        this.gating.add(s.id);
        let verdict: Awaited<ReturnType<typeof evaluateGate>>;
        try {
          verdict = await evaluateGate(this.runs, s);
        } finally {
          this.gating.delete(s.id);
        }
        gateSpend = { runId: verdict.gateRunId, costUsd: verdict.costUsd };
        if (verdict.kind === "skip") {
          this.repo.recordFiring(s.id, "skipped_gate", null, verdict.reason, nextAt(), gateSpend);
          log.info("schedule skipped by its gate", {
            schedule: s.name,
            reason: verdict.reason.slice(0, 200),
            gateCostUsd: verdict.costUsd,
          });
          return {
            outcome: "skipped_gate",
            runId: null,
            error: verdict.reason,
            gateRunId: verdict.gateRunId,
            gateCostUsd: verdict.costUsd,
          };
        }
        if (verdict.kind === "busy") throw new BusyError(verdict.reason);
        if (verdict.kind === "daily_cap") throw new DailyCapError(verdict.reason);
        if (verdict.kind === "budget") throw new BudgetError(verdict.reason);
        if (verdict.kind === "error") throw new Error(`gate: ${verdict.reason}`);
      }
      const input: Parameters<RunManager["startRun"]>[0] = { prompt: s.prompt, agentId: s.agentId, scheduleId: s.id };
      if (s.projectId) input.projectId = s.projectId;
      if (s.model) input.model = s.model;
      const run = await this.runs.startRun(input);
      if (resumable && resumeError)
        this.runs.note(run.id, `started fresh: the resume of run ${resumable.id} was refused (${resumeError})`);
      this.repo.recordFiring(s.id, "started", run.id, null, nextAt(), gateSpend);
      log.info("schedule fired", { schedule: s.name, runId: run.id, manual, gated: gateSpend !== null });
      return {
        outcome: "started",
        runId: run.id,
        error: null,
        ...(gateSpend ? { gateRunId: gateSpend.runId, gateCostUsd: gateSpend.costUsd } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof BusyError && !manual && this.runs.config.scheduler.deferBusy) {
        if (retry && s.deferredUntil) {
          // Still busy: put the pending back as it was (same deadline, the original tick's
          // message) and write nothing, so a long busy spell is one `deferred` row, not one per tick.
          // Only if nothing is pending now: a fresher pending (the next occurrence deferred by the
          // due loop while this retry's gate ran) must not be overwritten by the stale one.
          const restored = this.repo.restoreDeferred(s.id, s.deferredUntil, s.deferredReason ?? message);
          // A gate that ran cost something: keep its spend in a row of its own (schedule untouched).
          if (gateSpend) this.repo.recordGateSpend(s.id, "deferred", message, gateSpend);
          log.debug("deferred fire still busy", {
            schedule: s.name,
            deferredUntil: s.deferredUntil,
            restored,
            message,
          });
          return {
            outcome: "deferred",
            runId: null,
            error: message,
            ...(gateSpend ? { gateRunId: gateSpend.runId, gateCostUsd: gateSpend.costUsd } : {}),
          };
        }
        if (!retry && nextRunAt) {
          this.repo.recordFiring(s.id, "deferred", null, message, nextRunAt, gateSpend);
          this.repo.defer(s.id, nextRunAt, message);
          log.info("schedule busy; fire deferred", { schedule: s.name, deferredUntil: nextRunAt, message });
          return { outcome: "deferred", runId: null, error: message };
        }
      }
      // Structured, never matched on the text: a gate's stderr may well say "project busy".
      const outcome: ScheduleOutcome =
        err instanceof BusyError
          ? "skipped_busy"
          : err instanceof DailyCapError
            ? "skipped_daily_cap"
            : err instanceof BudgetError
              ? "skipped_budget"
              : "error";
      // A budget refusal has just paused the schedule: keep next_run_at cleared, as a pause does.
      const next = outcome === "skipped_budget" && !this.repo.get(s.id)?.enabled ? null : nextAt();
      this.repo.recordFiring(s.id, outcome, null, message, next, gateSpend);
      (outcome === "error" ? log.warn : log.info)("schedule not started", { schedule: s.name, outcome, message });
      return { outcome, runId: null, error: message };
    }
  }

  /**
   * The run to resume instead of starting fresh, when the schedule's policy (its own
   * `on_failure`, else the agent's) is `resume_once`, the run it last started ended
   * `budget_exhausted` or `timed_out`, and that run was not itself a resume: one retry,
   * a second failure is final and the next tick starts fresh.
   */
  resumeCandidate(s: Schedule): Run | null {
    const { last, willResumeRunId } = this.runState(s);
    return willResumeRunId ? last : null;
  }

  private runState(s: Schedule) {
    return scheduleRunState(s, this.runs.config.agents.get(s.agentId), {
      get: (id) => this.runs.getRun(id),
      resumedBy: (id) => this.runs.resumedBy(id),
    });
  }

  private computeNext(cron: string, timeZone: string): string | null {
    return nextRunAtFor(cron, timeZone, this.now());
  }
}
