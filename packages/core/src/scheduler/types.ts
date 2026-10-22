/**
 * Scheduling model. A Schedule says "run this agent with this prompt on this
 * cron, in this time zone". The Scheduler (scheduler.ts) fires due schedules
 * through RunManager, which keeps the WIP guards: a tick whose agent or project
 * is still busy is recorded as `skipped_busy`, never queued.
 */

import type { OnFailurePolicy } from "../config/types.js";

/**
 * `resumed` = started as a resume of the previous run (on_failure: resume_once); counts as a fire.
 * `skipped_gate` = the schedule's gate said there is no work; the reason is kept as the firing's error text.
 * `skipped_daily_cap` = the agent (or its gate agent) reached `max_daily_runs` / `max_daily_cost_usd` for the UTC day.
 * `skipped_budget` = a hard-stop budget covering the run (global, agent or project) is spent this UTC month;
 * the schedules of that scope were paused.
 * `auto_paused` = its last `scheduler.auto_pause_after` runs were all empty or needs review: the
 *   scheduler paused it instead of firing; the reason is kept as the firing's error text.
 */
export type ScheduleOutcome =
  | "started"
  | "resumed"
  | "skipped_busy"
  | "skipped_daily_cap"
  | "skipped_budget"
  | "skipped_gate"
  | "skipped_disabled"
  | "auto_paused"
  | "error";

/**
 * A cheap check before the real run. Exactly one of `command` / `agent`.
 *  - command: a shell command run in the project directory; exit 0 runs, exit 1-125 skips
 *    (its stdout is the reason); 126, 127, a signal or a timeout is an error. Costs nothing.
 *  - agent: a cheap agent run (its own prompt and budget, recorded as a run of kind "gate");
 *    when the last line of its final message is `marker` (default NO_WORK) the real run is skipped.
 */
export interface ScheduleGate {
  command?: string;
  /**
   * Set only when reading a stored gate that cannot be used (gate_json not valid JSON, or
   * neither command nor agent). The schedule then records `error` on every fire instead of
   * silently running ungated; validation refuses it.
   */
  invalid?: string;
  /** Command gate timeout. Default 60 s. A timeout is an `error`, not a skip. */
  timeoutSeconds?: number;
  agent?: {
    agentId: string;
    prompt: string;
    /** --max-budget-usd of the gate run. Default 0.5. */
    budgetUsd?: number;
    model?: string;
    /** The last line of the gate's final message that means "no work" (case-insensitive). Default NO_WORK. */
    marker?: string;
  };
}

/**
 * What a tick does when the schedule's agent or project is still busy. `skip_if_active` (the
 * only value for now) records `skipped_busy`; a busy tick is never queued.
 */
export const CONCURRENCY_POLICIES = ["skip_if_active"] as const;
export type ConcurrencyPolicy = (typeof CONCURRENCY_POLICIES)[number];

/**
 * What happens to ticks that were due while no process ticked. `skip_missed`: the schedule fires
 * once when it is next considered and next_run_at is recomputed from now, the rest are dropped.
 * `enqueue_missed_with_cap` (replay up to `CATCH_UP_CAP` missed ticks, never for sub-hourly
 * schedules) is reserved: validation refuses it until it is implemented.
 */
export const CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"] as const;
export type CatchUpPolicy = (typeof CATCH_UP_POLICIES)[number];
/** The values validation accepts today. */
export const IMPLEMENTED_CATCH_UP_POLICIES: readonly CatchUpPolicy[] = ["skip_missed"];
/** Most missed ticks `enqueue_missed_with_cap` would replay. */
export const CATCH_UP_CAP = 3;

/**
 * What makes a schedule due. `cron` (the only value for now): its cron expression in its time
 * zone. Stored so that other triggers (an API call, an event) can be added without a migration;
 * the scheduler's tick only considers `cron` schedules.
 */
export const TRIGGER_KINDS = ["cron"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const DEFAULT_TRIGGER_KIND: TriggerKind = "cron";

/**
 * A pause of the whole scheduler until a given instant (`pause_scheduler`), stored in the database
 * and read every tick: a friendlier kill switch next to `scheduler.enabled`, which needs a config
 * edit and is never lifted on its own. While paused nothing fires (due ticks and run-now requests
 * wait); the lease holder keeps the lease and the orphan sweep.
 */
export interface SchedulerPause {
  /** The pause ends at this instant; a past value means not paused. */
  pausedUntil: string;
  pausedAt: string;
  reason: string | null;
  /** The process that set it (`role@host:pid`). */
  pausedBy: string | null;
}

/** Longest pause `pause_scheduler` accepts, in minutes (7 days). Longer stops belong to `scheduler.enabled`. */
export const MAX_SCHEDULER_PAUSE_MINUTES = 7 * 24 * 60;

export const DEFAULT_CONCURRENCY_POLICY: ConcurrencyPolicy = "skip_if_active";
export const DEFAULT_CATCH_UP_POLICY: CatchUpPolicy = "skip_missed";

export const DEFAULT_GATE_MARKER = "NO_WORK";
export const DEFAULT_GATE_BUDGET_USD = 0.5;
export const DEFAULT_GATE_TIMEOUT_SECONDS = 60;

export interface Schedule {
  id: string;
  name: string;
  agentId: string;
  /** Project id; null when the agent is bound to a project (then its project is used). */
  projectId: string | null;
  prompt: string;
  model: string | null;
  /** 5-field cron expression, evaluated in `timeZone`. */
  cron: string;
  /** IANA zone, e.g. Europe/London. */
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Next instant the scheduler will consider this schedule due. */
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastOutcome: ScheduleOutcome | null;
  lastError: string | null;
  lastRunId: string | null;
  /** Counters since creation. */
  fires: number;
  skips: number;
  /**
   * Set by `ScheduleRepository.requestRun` (dashboard "Run now"); the lease holder fires the
   * schedule on its next tick, outside its cron and even when paused, and clears it.
   */
  runRequestedAt: string | null;
  /**
   * What the next tick does after a run ended `budget_exhausted` or `timed_out`:
   * `resume_once` resumes that session (one retry, a second failure is final), `none`
   * starts fresh. null = the agent's `on_failure` (default none).
   */
  onFailure: OnFailurePolicy | null;
  /** Budget of the resumed run; null = the agent's `resume_budget_usd`, else its `max_budget_usd`. */
  resumeBudgetUsd: number | null;
  /** Marker in a run's final message that means "nothing to do" (idle-cost stats); null = `scheduler.noop_pattern`. */
  noopPattern: string | null;
  /** Checked before every fresh run; null = no gate. */
  gate: ScheduleGate | null;
  /** What a tick does while the agent or project is busy (stored, default skip_if_active). */
  concurrencyPolicy: ConcurrencyPolicy;
  /** What happens to ticks missed while nobody ticked (stored, default skip_missed). */
  catchUpPolicy: CatchUpPolicy;
  /** What makes it due (stored, default and only value cron). */
  triggerKind: TriggerKind;
  /**
   * Why the scheduler paused it on its own (see `scheduler.auto_pause_after`); null when it is
   * enabled or was paused by hand. Cleared when the schedule is resumed.
   */
  pausedReason: string | null;
  /**
   * When the scheduler last auto-paused it. Kept after a resume: only runs created after it count
   * towards the next streak, so a resumed schedule gets `auto_pause_after` fresh runs.
   */
  autoPausedAt: string | null;
}

export interface ScheduleInput {
  name: string;
  agentId: string;
  projectId?: string | null;
  prompt: string;
  model?: string | null;
  cron: string;
  timeZone?: string;
  enabled?: boolean;
  onFailure?: OnFailurePolicy | null;
  resumeBudgetUsd?: number | null;
  noopPattern?: string | null;
  gate?: ScheduleGate | null;
  concurrencyPolicy?: ConcurrencyPolicy;
  catchUpPolicy?: CatchUpPolicy;
  triggerKind?: TriggerKind;
}

export type SchedulePatch = Partial<ScheduleInput>;

/** What the idle stats read about a schedule's runs in a window (`ScheduleRepository.runOutcomesSince`). */
export interface RunOutcomes {
  /** All runs of the schedule created in the window, and their total cost. */
  runs: number;
  costUsd: number;
  /**
   * Completed runs that do not need review (the only ones that can be no-ops), with the head
   * of their final message.
   */
  completed: Array<{ resultText: string; costUsd: number | null }>;
}

/** One row of the audit trail: every time a schedule was considered due. */
export interface ScheduleFiring {
  id: number;
  scheduleId: string;
  firedAt: string;
  outcome: ScheduleOutcome;
  runId: string | null;
  /** Why it did not start: the error, the busy message, or the gate's reason. */
  error: string | null;
  /** The gate agent's run, when an agent gate ran for this tick. */
  gateRunId: string | null;
  /** What the gate cost on this tick (0 for a command gate, null when no gate ran). */
  gateCostUsd: number | null;
}
