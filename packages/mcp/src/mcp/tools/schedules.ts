import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeCron, parseCron, type Schedule } from "@duskfleet/core";
import { errorResult, jsonResult, type ToolContext } from "../server.js";

function present(s: Schedule) {
  let human = s.cron;
  try {
    human = describeCron(parseCron(s.cron));
  } catch {
    // keep the raw expression
  }
  return { ...s, cronHuman: human };
}

const scheduleFields = {
  agent_id: z.string().min(1).describe("Agent to run (list_agents)"),
  prompt: z.string().min(1).describe("Prompt for every run. For an own agent that drives a project command, reference the command file, e.g. 'Follow .claude/commands/pickup-app-task.md'. For a link agent, tell it to run its own loop: it already IS the project agent, and a command that invokes that agent would make it invoke itself"),
  cron: z.string().min(1).describe('5-field cron, e.g. "0 8-20 * * 1-5" = weekdays 08–20 on the hour, "30 8-20 * * 1-5" = at :30. Evaluated in time_zone'),
  time_zone: z.string().min(1).optional().describe("IANA zone, default from config (Europe/London)"),
  project_id: z.string().min(1).optional().describe("Required unless the agent is bound to a project"),
  model: z.string().min(1).optional().describe("Model alias/id override for scheduled runs"),
  enabled: z.boolean().optional().describe("Default true"),
};

export function registerScheduleTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description:
        "List cron schedules with next/last firing, outcome of the last tick (started | skipped_busy | error) and scheduler status " +
        "(kill switch, which process holds the lease). A busy agent or project makes a tick skip, never queue.",
      inputSchema: {},
    },
    async () => jsonResult({ scheduler: ctx.scheduler.status(), schedules: ctx.scheduler.list().map(present) }),
  );

  server.registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description:
        "Create a cron schedule that runs an agent unattended. Stored in the DuskFleet database and picked up on the next tick " +
        "(≤ tick_seconds). Fails on an unknown agent/project, an invalid cron or time zone, or a duplicate name.",
      inputSchema: { name: z.string().min(1).describe("Unique, human name, e.g. 'app main hourly'"), ...scheduleFields },
    },
    async (args) => {
      try {
        const input: Parameters<typeof ctx.scheduler.create>[0] = { name: args.name, agentId: args.agent_id, prompt: args.prompt, cron: args.cron };
        if (args.time_zone !== undefined) input.timeZone = args.time_zone;
        else input.timeZone = ctx.config.scheduler.defaultTimeZone;
        if (args.project_id !== undefined) input.projectId = args.project_id;
        if (args.model !== undefined) input.model = args.model;
        if (args.enabled !== undefined) input.enabled = args.enabled;
        return jsonResult({ created: true, schedule: present(ctx.scheduler.create(input)) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_schedule",
    {
      title: "Update schedule",
      description: "Change fields of a schedule; omitted fields keep their value. enabled: false pauses it (next_run_at cleared), true resumes from now.",
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
        clear_model: z.boolean().optional().describe("Remove the model override"),
      },
    },
    async (args) => {
      try {
        const patch: Parameters<typeof ctx.scheduler.update>[1] = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.agent_id !== undefined) patch.agentId = args.agent_id;
        if (args.prompt !== undefined) patch.prompt = args.prompt;
        if (args.cron !== undefined) patch.cron = args.cron;
        if (args.time_zone !== undefined) patch.timeZone = args.time_zone;
        if (args.project_id !== undefined) patch.projectId = args.project_id;
        if (args.model !== undefined) patch.model = args.model;
        if (args.clear_model) patch.model = null;
        if (args.enabled !== undefined) patch.enabled = args.enabled;
        return jsonResult({ updated: true, schedule: present(ctx.scheduler.update(args.id, patch)) });
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
      inputSchema: { id: z.string().min(1).describe("Schedule id from list_schedules. Past runs and firings keep the id") },
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
      description: "Fire a schedule immediately, outside its cron (also when disabled). Same busy rules as a tick. Returns the run id or why it was skipped.",
      inputSchema: { id: z.string().min(1).describe("Schedule id from list_schedules. Fires now even if paused; WIP guards still apply") },
    },
    async (args) => {
      try {
        const result = await ctx.scheduler.fireNow(args.id);
        return jsonResult({ ...result, schedule: present(ctx.scheduler.get(args.id)!) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
