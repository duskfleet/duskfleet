/**
 * The Run model: one structured record per agent execution.
 * This is what SQLite stores and what MCP tools return.
 */

import type { DeniedTool, RunMcpInfo, SubagentRecord } from "../execution/types.js";

export const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled", "timed_out"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled", "timed_out"]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Exactly what was spawned. Recorded before execution starts. */
export interface RecordedCommand {
  binary: string;
  argv: string[];
  cwd: string;
}

/**
 * One Claude Code process of a run. Most runs have a single `main` phase; a run whose
 * main pass ended `budget_exhausted` gets a `wrap_up` phase (the same session resumed
 * with the reserve budget) whose cost, turns and tokens are folded into the run.
 */
export interface RunPhase {
  phase: "main" | "wrap_up";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Outcome of this process alone; the run's status comes from the main phase. */
  outcome: "completed" | "failed" | "cancelled" | "timed_out";
  terminationReason: string | null;
  /** The --max-budget-usd this phase was launched with. */
  budgetUsd: number | null;
  costUsd: number | null;
  numTurns: number | null;
  toolCalls: number;
}

export interface Run {
  id: string;
  agentId: string;
  projectPath: string;
  projectId: string | null;
  prompt: string;
  modelRequested: string | null;
  modelUsed: string | null;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  claudeSessionId: string | null;
  permissionMode: string;
  command: RecordedCommand;
  exitCode: number | null;
  terminationReason: string | null;
  error: string | null;
  resultText: string | null;
  numTurns: number | null;
  toolCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  permissionDenials: number | null;
  /** Tool calls refused by the permission system. Non-empty = the agent's allow-list is incomplete. */
  deniedTools: DeniedTool[];
  /** MCP servers mounted / used in this run and allow-list entries that matched none of them. */
  mcp: RunMcpInfo;
  /**
   * True when the run hit at least one permission denial. Kept for compatibility;
   * in unattended runs nobody can intervene, so read it as "needs review".
   */
  humanIntervention: boolean;
  contextExhausted: boolean;
  retries: number;
  logPath: string | null;
  rawResultJson: string | null;
  /** Set when the run was started by a schedule. */
  scheduleId: string | null;
  /** Process supervising the run, `role@host:pid`; null for runs recorded before ownership existed. */
  owner: string | null;
  /** The processes behind this run, in order (see RunPhase). Empty for runs recorded before migration 8. */
  phases: RunPhase[];
}

/** The wrap-up phase of a run, when there was one. */
export function wrapUpPhase(run: Pick<Run, "phases">): RunPhase | null {
  return run.phases.find((p) => p.phase === "wrap_up") ?? null;
}

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  type: "status_change" | "init" | "tool_use" | "error" | "note" | "subagent_start" | "subagent_end" | "phase";
  payload: unknown;
  /** Subagent (Claude Code task id) the event belongs to; null for the main session. */
  agentId: string | null;
}

/**
 * One subagent invocation inside a run, as stored in `run_agents`. The unit evals and
 * metrics can judge below the run: its own brief, report, tools, model and tokens.
 */
export interface RunAgent extends SubagentRecord {
  runId: string;
  /** Short hash of `<project>/.claude/agents/<subagentType>.md` at start time; null for builtins. */
  definitionHash: string | null;
}

/** Compact view used by list_runs. */
export function summarizeRun(run: Run) {
  return {
    id: run.id,
    status: run.status,
    agentId: run.agentId,
    scheduleId: run.scheduleId,
    projectPath: run.projectPath,
    projectId: run.projectId,
    prompt: run.prompt.length > 140 ? run.prompt.slice(0, 137) + "..." : run.prompt,
    model: run.modelUsed ?? run.modelRequested,
    claudeSessionId: run.claudeSessionId,
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    numTurns: run.numTurns,
    toolCalls: run.toolCalls,
    deniedTools: run.deniedTools,
    mcpAllowListedMissing: run.mcp.allowListedMissing,
    needsReview: run.humanIntervention || run.contextExhausted || run.mcp.allowListedMissing.length > 0,
    humanIntervention: run.humanIntervention,
    contextExhausted: run.contextExhausted,
    terminationReason: run.terminationReason,
    /** Outcome and cost of the wrap-up pass after a budget exhaustion; null when there was none. */
    wrapUp: summarizeWrapUp(run),
    error: run.error,
  };
}

export function summarizeWrapUp(
  run: Pick<Run, "phases">,
): { outcome: RunPhase["outcome"]; costUsd: number | null; durationMs: number } | null {
  const w = wrapUpPhase(run);
  return w ? { outcome: w.outcome, costUsd: w.costUsd, durationMs: w.durationMs } : null;
}
