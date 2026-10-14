import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RUN_STATUSES, summarizeRun, type Run, type RunAgent } from "@duskfleet/core";
import { errorResult, jsonResult, type ToolContext } from "../server.js";

const MAX_WAIT_SECONDS = 300;
const OUTPUT_LIMIT = 8_000;

function presentRun(run: Run, includeOutput: boolean) {
  const { rawResultJson, resultText, ...rest } = run;
  return {
    ...rest,
    resumeCommand: run.claudeSessionId ? `claude --resume ${run.claudeSessionId}` : null,
    resultText: includeOutput
      ? resultText
      : resultText && resultText.length > 300
        ? resultText.slice(0, 297) + "..."
        : resultText,
    resultTruncated: includeOutput && resultText !== null && resultText.length > OUTPUT_LIMIT,
    ...(includeOutput && resultText && resultText.length > OUTPUT_LIMIT ? { resultText: resultText.slice(0, OUTPUT_LIMIT) } : {}),
  };
}

/** Subagent rows are small except for prompt and report; those are shortened unless output was asked for. */
function presentSubagent(s: RunAgent, includeOutput: boolean) {
  const clip = (t: string | null) => (includeOutput || !t || t.length <= 300 ? t : t.slice(0, 297) + "...");
  // type / brief / report are what a reader asks for; subagentType / prompt / resultText are the stored names.
  return { type: s.subagentType, brief: clip(s.prompt), report: clip(s.resultText), ...s, prompt: clip(s.prompt), resultText: clip(s.resultText) };
}

export function registerRunTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "run_agent",
    {
      title: "Run agent",
      description:
        "Launch a Claude Code agent against a local project. The project directory becomes the working directory, " +
        "so the project's CLAUDE.md, .claude/ settings, skills and agents apply. Returns the run immediately " +
        "(status running) unless wait_seconds is given, in which case it waits up to that long for completion. " +
        "Poll with get_run afterwards.",
      inputSchema: {
        prompt: z.string().min(1).describe("The task for the agent"),
        project_path: z.string().optional().describe("Absolute path of the project (or ~/...). Mutually exclusive with project_id"),
        project_id: z.string().optional().describe("Id of a project from list_projects. Optional when the agent is bound to a project (list_agents → project)"),
        agent_id: z.string().optional().describe("Agent id from list_agents; required unless duskfleet.yaml sets default_agent"),
        model: z.string().optional().describe("Claude model alias or id, e.g. 'sonnet', 'opus'. Omit to use the agent/CLI default"),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`Wait up to N seconds (max ${MAX_WAIT_SECONDS}) for the run to finish`),
      },
    },
    async (args) => {
      try {
        const input: Parameters<typeof ctx.runs.startRun>[0] = { prompt: args.prompt };
        if (args.project_path !== undefined) input.projectPath = args.project_path;
        if (args.project_id !== undefined) input.projectId = args.project_id;
        if (args.agent_id !== undefined) input.agentId = args.agent_id;
        if (args.model !== undefined) input.model = args.model;
        let run = await ctx.runs.startRun(input);
        if (args.wait_seconds) {
          run = await ctx.runs.waitForRun(run.id, args.wait_seconds * 1000);
        }
        return jsonResult(presentRun(run, Boolean(args.wait_seconds)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description:
        "Fetch a run by id: status, timings, Claude session id, model, tokens, cost, tool calls, errors, " +
        "the command to resume the session and the subagents it delegated to (one entry per Agent call: type, brief, " +
        "report, tools, model, tokens). Set include_output to get the full final message, full subagent briefs and reports, and the event timeline.",
      inputSchema: {
        run_id: z.string().describe("Run id returned by run_agent or list_runs"),
        include_output: z.boolean().optional().describe("Include the full final message and the event timeline"),
      },
    },
    async ({ run_id, include_output }) => {
      const run = ctx.runs.getRun(run_id);
      if (!run) return errorResult(`run not found: ${run_id}`);
      const view = presentRun(run, Boolean(include_output));
      const subagents = ctx.runs.agents(run_id).map((s) => presentSubagent(s, Boolean(include_output)));
      /** The run that continued this one's session after a budget / timeout failure (on_failure: resume_once), or null. */
      const resumedByRunId = ctx.runs.resumedBy(run_id)?.id ?? null;
      return jsonResult(include_output ? { ...view, resumedByRunId, subagents, events: ctx.runs.events(run_id) } : { ...view, resumedByRunId, subagents });
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "List recent runs, newest first, with optional filters.",
      inputSchema: {
        status: z.enum(RUN_STATUSES).optional().describe("Only runs in this status"),
        kind: z.enum(["run", "gate"]).optional().describe("Only real runs, or only schedule gate-agent runs; both by default"),
        agent_id: z.string().optional().describe("Only runs of this agent (id from list_agents)"),
        project_path: z.string().optional().describe("Exact resolved project path"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 20"),
      },
    },
    async (args) => {
      const filter: Parameters<typeof ctx.runs.listRuns>[0] = {};
      if (args.status !== undefined) filter.status = args.status;
      if (args.kind !== undefined) filter.kind = args.kind;
      if (args.agent_id !== undefined) filter.agentId = args.agent_id;
      if (args.project_path !== undefined) filter.projectPath = args.project_path;
      if (args.limit !== undefined) filter.limit = args.limit;
      const runs = ctx.runs.listRuns(filter);
      // Linked retries both ways: a run that was resumed points at its retry, the retry at its origin.
      const resumedBy = ctx.runs.resumedByMany(runs.map((r) => r.id));
      return jsonResult({ active: ctx.runs.activeCount(), runs: runs.map((r) => ({ ...summarizeRun(r), resumedByRunId: resumedBy.get(r.id) ?? null })) });
    },
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel run",
      description: "Stop a running run (SIGTERM, then SIGKILL after a grace period). The run is recorded as cancelled.",
      inputSchema: { run_id: z.string().describe("Run id returned by run_agent or list_runs") },
    },
    async ({ run_id }) => {
      try {
        ctx.runs.cancelRun(run_id);
        const run = await ctx.runs.waitForRun(run_id, 8_000);
        return jsonResult(presentRun(run, false));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
