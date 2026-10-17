/**
 * Schedule create / update shared by every writer: the Scheduler (MCP tools,
 * CLI) and the dashboard's server actions. Validation and next_run_at live
 * here so a schedule edited from the dashboard obeys exactly the same rules
 * as one edited over MCP.
 */
import type { DuskFleetConfig } from "../config/types.js";
import type { ScheduleRepository } from "../storage/schedules.js";
import { assertTimeZone, CronError, nextFire, parseCron } from "./cron.js";
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

/** Merge a patch into an existing schedule. Resuming (`enabled: true`) recomputes next_run_at from `now`. */
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
  };
  validateScheduleInput(config, merged);
  if (merged.name !== existing.name && repo.findByName(merged.name))
    throw new Error(`a schedule named "${merged.name}" already exists`);
  const nextRunAt = merged.enabled ? nextRunAtFor(merged.cron, merged.timeZone!, now) : null;
  return repo.update(id, { ...merged, nextRunAt });
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
