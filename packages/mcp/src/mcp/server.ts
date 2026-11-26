/**
 * MCP server wiring. Each tool group lives in ./tools/*.ts and exports a
 * `register(server, ctx)` function. Add a file there and one line here to
 * expose a new tool.
 */

import {
  builtinHarnesses,
  type DuskFleetConfig,
  projectAgentGuidance,
  type RunManager,
  type Scheduler,
  SHIPPED_HARNESSES,
} from "@duskfleet/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerBudgetTools } from "./tools/budgets.js";
import { registerRunTools } from "./tools/runs.js";
import { registerScheduleTools } from "./tools/schedules.js";

export interface ToolContext {
  /** Fresh config: re-read from disk on every access so edits under config/ apply immediately. */
  readonly config: DuskFleetConfig;
  runs: RunManager;
  scheduler: Scheduler;
  executorInfo: { name: string; binary: string; version: string | null };
}

export const SERVER_VERSION = "0.6.0";
export const SERVER_INSTRUCTIONS =
  "Duskfleet runs autonomous Claude Code agents against local projects. " +
  "Use list_agents and list_projects to discover what is available, run_agent to start a run " +
  "(returns immediately with a run_id unless wait_seconds is set), and get_run / list_runs to inspect results. " +
  "create_agent / update_agent manage agent definitions: an agent is either kind 'own' (new persona written in Duskfleet) " +
  "or kind 'link' (project_agent: reuses an agent the project defines for the agent's harness, see list_project_agents) — always choose explicitly. " +
  "create_schedule / list_schedules manage cron schedules. set_budget / list_budgets manage monthly budgets (global, agent, project). " +
  "An agent runs on the harness its file names (claude, copilot, codex or cursor), whatever MCP host is asking. " +
  `Each harness has its own folder of project agents (${projectAgentGuidance(SHIPPED_HARNESSES, builtinHarnesses)}): ` +
  "only that folder is ever the place for an agent of that harness, and a harness without links takes kind 'own' only (the persona goes in system_prompt). " +
  "Settle the agent's harness before choosing link (ask when the project does not make it clear); Duskfleet never writes agent files into a project.";

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "duskfleet", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerAgentTools(server, ctx);
  registerRunTools(server, ctx);
  registerScheduleTools(server, ctx);
  registerBudgetTools(server, ctx);
  return server;
}

/** Uniform tool response helpers. */
export function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
