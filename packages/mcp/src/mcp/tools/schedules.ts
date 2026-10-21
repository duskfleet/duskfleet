import {
  describeCron,
  type IdleStats,
  ON_FAILURE_POLICIES,
  parseCron,
  type Schedule,
  type ScheduleGate,
  type ScheduleRunState,
} from "@duskfleet/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, jsonResult, type ToolContext } from "../server.js";

/**
 * A schedule as the tools return it. The run state (lastRun: how the run it last started *ended*,
 * effectiveOnFailure, willResumeRunId, idle7d) comes from Scheduler.withLastRun / listWithLastRun; this
 * only adds the cron in words.
 */
function present(s: Schedule & ScheduleRunState & { idle7d: IdleStats }) {
  let human = s.cron;
  try {
    human = describeCron(parseCron(s.cron));
  } catch {
    // keep the raw expression
  }
  return { ...s, cronHuman: human };
}

const gateSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Shell command run in the project directory before each run: exit 0 = work to do, run; exit 1-125 = skip (stdout kept as the reason); 126/127 (not executable, not found), a signal or a timeout = error. Costs nothing",
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("Command gate timeout, default 60. A timeout is an error, not a skip"),
    agent: z
      .object({
        agent_id: z.string().min(1).describe("A cheap agent (e.g. one with model: haiku) that checks for work"),
        prompt: z
          .string()
          .min(1)
          .describe(
            "What the gate agent checks. Tell it to end its answer with the marker alone on the last line when there is no work",
          ),
        budget_usd: z.number().positive().optional().describe("--max-budget-usd of the gate run, default 0.5"),
        model: z.string().min(1).optional().describe("Model override for the gate run"),
        marker: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The last line of its final message that means no work (case-insensitive; a mention mid-sentence does not count); default "NO_WORK"',
          ),
      })
      .optional(),
  })
  .describe(
    "Skip a tick cheaply when there is no work: exactly one of command or agent. Skips are recorded as skipped_gate; agent gate cost is counted apart from run cost",
  );

/** MCP shape (snake_case) → core ScheduleGate. */
function toGate(g: z.infer<typeof gateSchema>): ScheduleGate {
  const gate: ScheduleGate = {};
  if (g.command !== undefined) gate.command = g.command;
  if (g.timeout_seconds !== undefined) gate.timeoutSeconds = g.timeout_seconds;
  if (g.agent) {
    const a: NonNullable<ScheduleGate["agent"]> = { agentId: g.agent.agent_id, prompt: g.agent.prompt };
    if (g.agent.budget_usd !== undefined) a.budgetUsd = g.agent.budget_usd;
    if (g.agent.model !== undefined) a.model = g.agent.model;
    if (g.agent.marker !== undefined) a.marker = g.agent.marker;
    gate.agent = a;
  }
  return gate;
}

const scheduleFields = {
  agent_id: z.string().min(1).describe("Agent to run (list_agents)"),
  prompt: z
    .string()
    .min(1)
    .describe(
      "Prompt for every run. For an own agent that drives a project command, reference the command file, e.g. 'Follow .claude/commands/pickup-task.md'. For a link agent, tell it to run its own loop: it already IS the project agent, and a command that invokes that agent would make it invoke itself",
    ),
  cron: z
    .string()
    .min(1)
    .describe(
      '5-field cron, e.g. "0 8-20 * * 1-5" = weekdays 08–20 on the hour, "30 8-20 * * 1-5" = at :30. Evaluated in time_zone',
    ),
  time_zone: z.string().min(1).optional().describe("IANA zone, default from config (Europe/London)"),
  project_id: z.string().min(1).optional().describe("Required unless the agent is bound to a project"),
  model: z.string().min(1).optional().describe("Model alias/id override for scheduled runs"),
  enabled: z.boolean().optional().describe("Default true"),
  on_failure: z
    .enum(ON_FAILURE_POLICIES)
    .optional()
    .describe(
      "What the next tick does after a run ended budget_exhausted or timed_out: resume_once resumes that session (claude --resume, once; a second failure is final), none starts fresh. Omit to inherit the agent's on_failure",
    ),
  resume_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Budget of the resumed run; defaults to the agent's resume_budget_usd, else its max_budget_usd"),
  noop_pattern: z
    .string()
    .min(1)
    .optional()
    .describe(
      'What this schedule\'s agent says when it finds no work, for the idle-cost stats (idle7d): a regex literal "/.../flags" or a plain case-insensitive regex. Tested against the start of the final message (first 2000 chars). Default scheduler.noop_pattern ("/^\\s*(nothing to do|no .* in ready)/i")',
    ),
  gate: gateSchema.optional(),
};

export function registerScheduleTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description:
        "List cron schedules with next/last firing, outcome of the last tick (started | resumed | skipped_busy | skipped_daily_cap | skipped_gate | skipped_disabled | auto_paused | error), pausedReason (why the scheduler paused it on its own after scheduler.auto_pause_after empty or needs-review runs in a row; null otherwise, cleared on resume), gate (the cheap check before each run, or null), lastRun (status, needsReview and reviewReasons of the run it last started: a schedule whose run failed or ran out of budget shows it here), " +
        "effectiveOnFailure (none | resume_once: the schedule's own on_failure, else the agent's) with onFailureSource, willResumeRunId (the budget_exhausted / timed_out run the next fire resumes instead of starting fresh, or null), effectiveProjectId (the project it runs on: projectId, else the agent's project; projectId stays the stored value) and scheduler status " +
        "(kill switch, which process holds the lease). A busy agent or project makes a tick skip, never queue.",
      inputSchema: {},
    },
    async () =>
      jsonResult({ scheduler: ctx.scheduler.status(), schedules: ctx.scheduler.listWithLastRun().map(present) }),
  );

  server.registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description:
        "Create a cron schedule that runs an agent unattended. Stored in the DuskFleet database and picked up on the next tick " +
        "(≤ tick_seconds). Fails on an unknown agent/project, an invalid cron or time zone, or a duplicate name.",
      inputSchema: {
        name: z.string().min(1).describe("Unique, human name, e.g. 'app main hourly'"),
        ...scheduleFields,
      },
    },
    async (args) => {
      try {
        const input: Parameters<typeof ctx.scheduler.create>[0] = {
          name: args.name,
          agentId: args.agent_id,
          prompt: args.prompt,
          cron: args.cron,
        };
        if (args.time_zone !== undefined) input.timeZone = args.time_zone;
        else input.timeZone = ctx.config.scheduler.defaultTimeZone;
        if (args.project_id !== undefined) input.projectId = args.project_id;
        if (args.model !== undefined) input.model = args.model;
        if (args.enabled !== undefined) input.enabled = args.enabled;
        if (args.on_failure !== undefined) input.onFailure = args.on_failure;
        if (args.resume_budget_usd !== undefined) input.resumeBudgetUsd = args.resume_budget_usd;
        if (args.noop_pattern !== undefined) input.noopPattern = args.noop_pattern;
        if (args.gate !== undefined) input.gate = toGate(args.gate);
        return jsonResult({ created: true, schedule: present(ctx.scheduler.withLastRun(ctx.scheduler.create(input))) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_schedule",
    {
      title: "Update schedule",
      description:
        "Change fields of a schedule; omitted fields keep their value. enabled: false pauses it (next_run_at cleared), true resumes from now.",
      inputSchema: {
        id: z.string().min(1).describe("Schedule id from list_schedules"),
        name: z.string().min(1).optional().describe("New human name"),
        agent_id: scheduleFields.agent_id.optional(),
        prompt: scheduleFields.prompt.optional(),
        cron: scheduleFields.cron.optional(),
        time_zone: scheduleFields.time_zone,
        project_id: scheduleFields.project_id,
        model: scheduleFields.model,
        enabled: scheduleFields.enabled,
        on_failure: scheduleFields.on_failure,
        resume_budget_usd: scheduleFields.resume_budget_usd,
        noop_pattern: scheduleFields.noop_pattern,
        clear_noop_pattern: z
          .boolean()
          .optional()
          .describe("Remove the schedule's noop_pattern: scheduler.noop_pattern applies again"),
        gate: scheduleFields.gate,
        clear_gate: z.boolean().optional().describe("Remove the gate: every tick starts the real run again"),
        clear_model: z.boolean().optional().describe("Remove the model override"),
        clear_on_failure: z
          .boolean()
          .optional()
          .describe("Remove the schedule's on_failure and resume_budget_usd: the agent's apply again"),
      },
    },
    async (args) => {
      try {
        if (args.noop_pattern !== undefined && args.clear_noop_pattern) {
          throw new Error("noop_pattern and clear_noop_pattern cannot be used together");
        }
        if (args.gate !== undefined && args.clear_gate) {
          throw new Error("gate and clear_gate cannot be used together");
        }
        const patch: Parameters<typeof ctx.scheduler.update>[1] = {};
        if (args.on_failure !== undefined) patch.onFailure = args.on_failure;
        if (args.resume_budget_usd !== undefined) patch.resumeBudgetUsd = args.resume_budget_usd;
        if (args.noop_pattern !== undefined) patch.noopPattern = args.noop_pattern;
        else if (args.clear_noop_pattern) patch.noopPattern = null;
        if (args.gate !== undefined) patch.gate = toGate(args.gate);
        else if (args.clear_gate) patch.gate = null;
        if (args.clear_on_failure) {
          patch.onFailure = null;
          patch.resumeBudgetUsd = null;
        }
        if (args.name !== undefined) patch.name = args.name;
        if (args.agent_id !== undefined) patch.agentId = args.agent_id;
        if (args.prompt !== undefined) patch.prompt = args.prompt;
        if (args.cron !== undefined) patch.cron = args.cron;
        if (args.time_zone !== undefined) patch.timeZone = args.time_zone;
        if (args.project_id !== undefined) patch.projectId = args.project_id;
        if (args.model !== undefined) patch.model = args.model;
        if (args.clear_model) patch.model = null;
        if (args.enabled !== undefined) patch.enabled = args.enabled;
        return jsonResult({
          updated: true,
          schedule: present(ctx.scheduler.withLastRun(ctx.scheduler.update(args.id, patch))),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule. Past runs keep their schedule_id.",
      inputSchema: {
        id: z.string().min(1).describe("Schedule id from list_schedules. Past runs and firings keep the id"),
      },
    },
    async (args) => {
      const deleted = ctx.scheduler.delete(args.id);
      return deleted ? jsonResult({ deleted: true }) : errorResult(new Error(`schedule not found: ${args.id}`));
    },
  );

  server.registerTool(
    "run_schedule_now",
    {
      title: "Run schedule now",
      description:
        "Fire a schedule immediately, outside its cron (also when disabled). Same busy and gate rules as a tick (an agent gate is waited for). Returns the run id or why it was skipped.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Schedule id from list_schedules. Fires now even if paused; WIP guards still apply"),
        skip_gate: z.boolean().optional().describe("Start the real run without asking the schedule's gate"),
      },
    },
    async (args) => {
      try {
        const result = await ctx.scheduler.fireNow(args.id, { skipGate: args.skip_gate ?? false });
        return jsonResult({ ...result, schedule: present(ctx.scheduler.withLastRun(ctx.scheduler.get(args.id)!)) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
