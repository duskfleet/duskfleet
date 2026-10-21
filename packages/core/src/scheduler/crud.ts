/**
 * Schedule create / update shared by every writer: the Scheduler (MCP tools,
 * CLI) and the dashboard's server actions. Validation and next_run_at live
 * here so a schedule edited from the dashboard obeys exactly the same rules
 * as one edited over MCP.
 */
import { hostname } from "node:os";
import {
  type AgentDefinition,
  type DuskFleetConfig,
  ON_FAILURE_POLICIES,
  type OnFailurePolicy,
} from "../config/types.js";
import { isResumable, type LastRunSummary, lastRunSummary, type Run } from "../observability/run.js";
import type { ScheduleRepository } from "../storage/schedules.js";
import { assertTimeZone, CronError, nextFire, parseCron } from "./cron.js";
import { validateGate } from "./gate.js";
import { parseNoopPattern } from "./idle.js";
import type { Schedule, ScheduleInput, SchedulePatch } from "./types.js";

export const DEFAULT_TIME_ZONE = "Europe/London";

export function nextRunAtFor(cron: string, timeZone: string, now: Date = new Date()): string | null {
  const next = nextFire(parseCron(cron), now, timeZone);
  return next ? next.toISOString() : null;
}

export function validateScheduleInput(config: DuskFleetConfig, input: ScheduleInput): void {
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.prompt?.trim()) throw new Error("prompt is required");
  try {
    parseCron(input.cron);
    assertTimeZone(input.timeZone ?? DEFAULT_TIME_ZONE);
  } catch (err) {
    if (err instanceof CronError) throw new Error(err.message);
    throw err;
  }
  const agent = config.agents.get(input.agentId);
  if (!agent) throw new Error(`unknown agent "${input.agentId}". Known: ${[...config.agents.keys()].join(", ")}`);
  if (input.projectId && !config.projects.has(input.projectId)) {
    throw new Error(`unknown project "${input.projectId}". Known: ${[...config.projects.keys()].join(", ")}`);
  }
  if (!input.projectId && !agent.project) {
    throw new Error(`agent "${input.agentId}" is not bound to a project; pass project_id`);
  }
  if (input.projectId && agent.project && agent.project !== input.projectId) {
    throw new Error(
      `agent "${input.agentId}" belongs to project "${agent.project}", cannot schedule it on "${input.projectId}"`,
    );
  }
  if (input.onFailure != null && !(ON_FAILURE_POLICIES as readonly string[]).includes(input.onFailure)) {
    throw new Error(`on_failure must be one of ${ON_FAILURE_POLICIES.join(", ")}`);
  }
  if (input.resumeBudgetUsd != null && !(Number.isFinite(input.resumeBudgetUsd) && input.resumeBudgetUsd > 0)) {
    throw new Error("resume_budget_usd must be a positive number");
  }
  if (input.noopPattern != null) parseNoopPattern(input.noopPattern);
  if (input.gate != null) validateGate(config, input.gate, scheduleProjectId(input, agent));
}

/**
 * The project a schedule runs on: its own project_id when set, else the project its agent is
 * bound to, else null (an unbound agent without a schedule project, or a deleted agent).
 * The scheduler, the MCP / CLI listings and the dashboard grouping all use this one rule.
 */
export function scheduleProjectId(
  schedule: { projectId?: string | null },
  agent: Pick<AgentDefinition, "project"> | undefined,
): string | null {
  return schedule.projectId ?? agent?.project ?? null;
}

/** The policy a schedule applies after a failed run: its own, else its agent's, else none. */
export function effectiveOnFailure(
  schedule: Pick<Schedule, "onFailure">,
  agent: Pick<AgentDefinition, "onFailure"> | undefined,
): OnFailurePolicy {
  return schedule.onFailure ?? agent?.onFailure ?? "none";
}

/**
 * Whether the schedule's next fire resumes `lastRun` (the run it last started) instead of
 * starting fresh: policy `resume_once`, the run ended budget_exhausted or timed_out, it is
 * not itself a resume, and nothing resumed it yet. One retry; a second failure is final.
 * The run must also still match the schedule: an edit of its agent, project, prompt or model
 * after the failure means the next fire starts fresh with the new values.
 */
export function willResume(
  schedule: Pick<Schedule, "onFailure" | "agentId" | "projectId" | "prompt" | "model">,
  agent: Pick<AgentDefinition, "onFailure" | "project"> | undefined,
  lastRun: Pick<
    Run,
    | "status"
    | "terminationReason"
    | "claudeSessionId"
    | "resumedFromRunId"
    | "agentId"
    | "projectId"
    | "prompt"
    | "modelRequested"
  > | null,
  alreadyResumed: boolean,
): boolean {
  if (!lastRun || effectiveOnFailure(schedule, agent) !== "resume_once") return false;
  if (!isResumable(lastRun) || lastRun.resumedFromRunId !== null || alreadyResumed) return false;
  return (
    lastRun.agentId === schedule.agentId &&
    lastRun.projectId === scheduleProjectId(schedule, agent) &&
    lastRun.prompt === schedule.prompt.trim() &&
    lastRun.modelRequested === (schedule.model ?? null)
  );
}

/** What a schedule list shows about its last run and its on_failure policy (MCP, CLI and dashboard). */
export interface ScheduleRunState {
  /** How the run the schedule last started ended (null before the first firing). */
  lastRun: LastRunSummary | null;
  /** The policy that applies on the next fire: the schedule's own on_failure, else the agent's. */
  effectiveOnFailure: OnFailurePolicy;
  /** Where effectiveOnFailure comes from. */
  onFailureSource: "schedule" | "agent" | "default";
  /** Set when the next fire resumes this run instead of starting fresh. */
  willResumeRunId: string | null;
  /**
   * The project the schedule runs on (scheduleProjectId): its stored projectId, else its
   * agent's project. projectId keeps the stored value, null for a bound agent.
   */
  effectiveProjectId: string | null;
}

/**
 * The one composition of a schedule's run state, shared by the Scheduler (MCP, CLI) and the
 * dashboard: loads the last run once and asks whether anything resumed it.
 */
export function scheduleRunState(
  schedule: Schedule,
  agent: AgentDefinition | undefined,
  runs: { get(id: string): Run | null; resumedBy(id: string): Run | null },
): ScheduleRunState & { last: Run | null } {
  const last = schedule.lastRunId ? runs.get(schedule.lastRunId) : null;
  const resume = last !== null && willResume(schedule, agent, last, runs.resumedBy(last.id) !== null);
  return {
    last,
    lastRun: lastRunSummary(last),
    effectiveOnFailure: effectiveOnFailure(schedule, agent),
    onFailureSource: schedule.onFailure ? "schedule" : agent?.onFailure ? "agent" : "default",
    willResumeRunId: resume ? last.id : null,
    effectiveProjectId: scheduleProjectId(schedule, agent),
  };
}

export function createSchedule(
  repo: ScheduleRepository,
  config: DuskFleetConfig,
  input: ScheduleInput,
  now: Date = new Date(),
): Schedule {
  validateScheduleInput(config, input);
  if (repo.findByName(input.name)) throw new Error(`a schedule named "${input.name}" already exists`);
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const nextRunAt = input.enabled === false ? null : nextRunAtFor(input.cron, timeZone, now);
  return repo.insert({ ...input, timeZone, nextRunAt });
}

/**
 * Merge a patch into an existing schedule. Resuming (`enabled: true`) recomputes next_run_at from
 * `now` and clears an auto-pause reason (auto_paused_at stays: older runs do not count again).
 */
export function updateSchedule(
  repo: ScheduleRepository,
  config: DuskFleetConfig,
  id: string,
  patch: SchedulePatch,
  now: Date = new Date(),
): Schedule {
  const existing = repo.get(id);
  if (!existing) throw new Error(`schedule not found: ${id}`);
  const merged: ScheduleInput = {
    name: patch.name ?? existing.name,
    agentId: patch.agentId ?? existing.agentId,
    projectId: patch.projectId === undefined ? existing.projectId : patch.projectId,
    prompt: patch.prompt ?? existing.prompt,
    model: patch.model === undefined ? existing.model : patch.model,
    cron: patch.cron ?? existing.cron,
    timeZone: patch.timeZone ?? existing.timeZone,
    enabled: patch.enabled ?? existing.enabled,
    onFailure: patch.onFailure === undefined ? existing.onFailure : patch.onFailure,
    resumeBudgetUsd: patch.resumeBudgetUsd === undefined ? existing.resumeBudgetUsd : patch.resumeBudgetUsd,
    noopPattern: patch.noopPattern === undefined ? existing.noopPattern : patch.noopPattern,
    gate: patch.gate === undefined ? existing.gate : patch.gate,
  };
  validateScheduleInput(config, merged);
  if (merged.name !== existing.name && repo.findByName(merged.name))
    throw new Error(`a schedule named "${merged.name}" already exists`);
  const nextRunAt = merged.enabled ? nextRunAtFor(merged.cron, merged.timeZone!, now) : null;
  return repo.update(id, { ...merged, nextRunAt, ...(merged.enabled ? { pausedReason: null } : {}) });
}

/**
 * The reason to auto-pause a schedule before its next scheduled fire, or null to fire: its last
 * `limit` ended runs (created after its previous auto-pause) all completed with 0 tool calls or
 * ended needs review. Fewer ended runs than `limit`, or `limit` 0, never pauses. A cancelled or
 * clean run breaks the streak.
 */
export function autoPauseReason(
  repo: Pick<ScheduleRepository, "recentEndedRuns">,
  schedule: Pick<Schedule, "id" | "autoPausedAt">,
  limit: number,
): string | null {
  if (!(limit > 0)) return null;
  const runs = repo.recentEndedRuns(schedule.id, schedule.autoPausedAt, limit);
  if (runs.length < limit || !runs.every((r) => r.empty || r.needsReview)) return null;
  const review = runs.filter((r) => r.needsReview).length;
  const empty = runs.filter((r) => r.empty && !r.needsReview).length;
  const parts = [
    ...(empty > 0 ? [`${empty} completed with 0 tool calls`] : []),
    ...(review > 0 ? [`${review} needed review`] : []),
  ];
  return `auto-paused: the last ${limit} runs did no useful work (${parts.join(", ")}); last run ${runs[0]!.id}`;
}

/**
 * The scheduler lease is held by `<role>@<host>:<pid>`. `role` says which kind
 * of process ticks: `serve` (the installed service or a manual `duskfleet serve`),
 * `mcp` (the server an MCP host keeps alive) or `cli`. Older rows are plain
 * `host:pid` and parse with role `unknown`.
 */
export type SchedulerRole = "serve" | "mcp" | "cli" | "unknown";

export function formatHolder(role: SchedulerRole, host: string, pid: number): string {
  return `${role}@${host}:${pid}`;
}

/** This process as `<role>@<host>:<pid>`: the lease holder and the owner of the runs it starts. */
export function processIdentity(role: SchedulerRole = "unknown"): string {
  return formatHolder(role, hostname(), process.pid);
}

export function parseHolder(holder: string): { role: SchedulerRole; host: string; pid: number | null } {
  const at = holder.indexOf("@");
  const role = at > 0 ? holder.slice(0, at) : "unknown";
  const rest = at > 0 ? holder.slice(at + 1) : holder;
  const colon = rest.lastIndexOf(":");
  const host = colon > 0 ? rest.slice(0, colon) : rest;
  const pid = colon > 0 ? Number(rest.slice(colon + 1)) : NaN;
  const known: SchedulerRole[] = ["serve", "mcp", "cli"];
  return {
    role: (known as string[]).includes(role) ? (role as SchedulerRole) : "unknown",
    host,
    pid: Number.isFinite(pid) ? pid : null,
  };
}
