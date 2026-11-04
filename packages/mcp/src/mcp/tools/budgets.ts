import { BUDGET_SCOPES, type BudgetInput, UNPRICED_POLICIES } from "@duskfleet/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, jsonResult, type ToolContext } from "../server.js";

export function registerBudgetTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_budgets",
    {
      title: "List budgets",
      description:
        "List the monthly budgets (one per scope: global, agent <id>, project <id>; calendar month in UTC) with this month's " +
        "spentUsd (recorded cost of the scope's runs, gate runs included), the runs of unknown cost (unpricedRuns: ended without " +
        "a cost; runningRuns: not settled yet) and the standInUsd they count for, countedUsd (spentUsd + standInUsd), percent and " +
        "state: ok, warn (at or past warn_percent) or over (countedUsd reached amount_usd). Under unpriced_policy count (default) " +
        "an unknown run counts as its agent's max_budget_usd, or as the whole remaining budget when the agent sets none. A spent " +
        "hard_stop budget refuses new runs in its scope and pauses its schedules (skipped_budget); over only by running runs " +
        "(overByRunning) it refuses without pausing.",
      inputSchema: {},
    },
    async () => jsonResult({ budgets: ctx.runs.budgetStatuses() }),
  );

  server.registerTool(
    "set_budget",
    {
      title: "Set budget",
      description:
        "Create the monthly budget of a scope, or replace the one it has. Checked before every run: once the scope's spend this " +
        "UTC month reaches amount_usd, a hard_stop budget refuses new runs (a run in progress is not stopped) and pauses every " +
        "enabled schedule of the scope; they stay paused until resumed with update_schedule. Fails on an unknown agent or project.",
      inputSchema: {
        scope: z
          .enum(BUDGET_SCOPES)
          .describe("global (every run), agent (one agent's runs) or project (runs on one project)"),
        scope_id: z
          .string()
          .min(1)
          .optional()
          .describe("Agent id (scope agent) or project id (scope project); omit for global"),
        amount_usd: z.number().positive().describe("Spend allowed per calendar month (UTC)"),
        warn_percent: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Share of amount_usd past which the budget shows as warn; default 80"),
        hard_stop: z
          .boolean()
          .optional()
          .describe("Default true: refuse runs and pause the scope's schedules once spent. false = warn only"),
        unpriced_policy: z
          .enum(UNPRICED_POLICIES)
          .optional()
          .describe(
            "count (default, fail closed): a run with no recorded cost, or still running, counts as its agent's max_budget_usd, " +
              "or as the whole remaining budget when the agent sets none. allow: only recorded costs count",
          ),
      },
    },
    async (args) => {
      try {
        const input: BudgetInput = { scope: args.scope, amountUsd: args.amount_usd };
        if (args.scope_id !== undefined) input.scopeId = args.scope_id;
        if (args.warn_percent !== undefined) input.warnPercent = args.warn_percent;
        if (args.hard_stop !== undefined) input.hardStop = args.hard_stop;
        if (args.unpriced_policy !== undefined) input.unpricedPolicy = args.unpriced_policy;
        return jsonResult({ set: true, budget: ctx.runs.setBudget(input) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_budget",
    {
      title: "Delete budget",
      description: "Delete a budget. Schedules it paused stay paused: resume them with update_schedule enabled: true.",
      inputSchema: { id: z.string().min(1).describe("Budget id from list_budgets") },
    },
    async (args) =>
      ctx.runs.deleteBudget(args.id)
        ? jsonResult({ deleted: true })
        : errorResult(new Error(`budget not found: ${args.id}`)),
  );
}
