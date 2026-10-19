/**
 * Scheduling model. A Schedule says "run this agent with this prompt on this
 * cron, in this time zone". The Scheduler (scheduler.ts) fires due schedules
 * through RunManager, which keeps the WIP guards: a tick whose agent or project
 * is still busy is recorded as `skipped_busy`, never queued.
 */

import type { OnFailurePolicy } from "../config/types.js";

/** `resumed` = started as a resume of the previous run (on_failure: resume_once); counts as a fire. */
export type ScheduleOutcome = "started" | "resumed" | "skipped_busy" | "skipped_disabled" | "error";

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
  error: string | null;
}
