/**
 * The Run model: one structured record per agent execution.
 * This is what SQLite stores and what MCP tools return.
 */

import type { DeniedTool, RunMcpInfo, SubagentRecord, UsageByModel } from "../execution/types.js";

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
  /**
   * Tokens per model id, from the result line's `modelUsage` (migration 13). The token totals
   * above are its sum, subagents included. Null when the result had no `modelUsage` (older rows,
   * runs without a result line); the totals then come from the result's `usage`.
   */
  usageByModel: UsageByModel | null;
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
  /**
   * Why this run needs a human, as `RunManager` computed it with `reviewReasons()` when the
   * run reached its terminal status (`review_reasons_json`, migration 8; backfilled for
   * older rows). Empty while the run is pending or running. Readers use this field, never
   * the rule: lists, badges and aggregates (`NEEDS_REVIEW_SQL`) all read the same stored value.
   */
  reviewReasons: ReviewReason[];
  /**
   * Set when this run resumed the session of an earlier run that ended `budget_exhausted` or
   * `timed_out` (a schedule's `on_failure: resume_once`). The original run is found through
   * `RunRepository.resumedBy`.
   */
  resumedFromRunId: string | null;
  /** `gate` = a schedule's gate agent deciding whether there is work; its cost is counted apart. `run` otherwise. */
  kind: RunKind;
}

export type RunKind = "run" | "gate";

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

/** A RunAgent under the names readers use (`type`, `brief`, `report`), same set on `get_run` and the CLI. */
export type RunAgentView = Omit<RunAgent, "subagentType" | "prompt" | "resultText"> & {
  type: string;
  brief: string | null;
  report: string | null;
};

/** The one renaming from stored names (subagentType / prompt / resultText) to reader names, `clip` applied to brief and report. */
export function subagentView(s: RunAgent, clip: (t: string | null) => string | null = (t) => t): RunAgentView {
  const { subagentType, prompt, resultText, ...rest } = s;
  return { type: subagentType, brief: clip(prompt), report: clip(resultText), ...rest };
}

/**
 * Why a run needs a human to look at it. Anything that stopped the run before the agent
 * chose to stop, or that silently narrowed what it could do, counts: a run that failed
 * but looked green in a list is how a budget stop on 2026-10-14 went unnoticed for 11 hours.
 * `cancelled` is not a reason (a person did it); running runs have none yet.
 *
 * `reviewReasons()` is the rule; `RunManager` applies it once, at the terminal transition,
 * and stores the result in `Run.reviewReasons`. Everything that displays or counts runs
 * reads the stored value, so the rule has exactly one writer and cannot drift from the SQL.
 */
export type ReviewReason =
  | "budget_exhausted"
  | "timed_out"
  | "orphaned"
  | "nonzero_exit"
  | "failed"
  | "permission_denied"
  | "context_exhausted"
  | "mcp_missing";

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  budget_exhausted: "budget exhausted",
  timed_out: "timed out",
  orphaned: "orphaned by a restart",
  nonzero_exit: "non-zero exit code",
  failed: "failed",
  permission_denied: "permission denied",
  context_exhausted: "context exhausted",
  mcp_missing: "allow-listed MCP server not mounted",
};

/** The run stopped because `--max-budget-usd` was reached (`terminal_reason: budget_exhausted`, `subtype: error_max_budget_usd`; verified 2026-10-14 on CLI 2.1.299). */
export function isBudgetExhausted(terminationReason: string | null | undefined): boolean {
  return typeof terminationReason === "string" && /budget/i.test(terminationReason);
}

/**
 * The `error` RunManager writes on a `running` run whose owning process is gone. Readers
 * detect an orphan through `isOrphaned()`, never by matching this text themselves.
 */
export const ORPHANED_ERROR_PREFIX = "orphaned:";

export function orphanedError(owner: string | null): string {
  return `${ORPHANED_ERROR_PREFIX} owning process ${owner ?? "(unrecorded)"} is gone`;
}

export function isOrphaned(run: Pick<Run, "error">): boolean {
  return typeof run.error === "string" && run.error.startsWith(ORPHANED_ERROR_PREFIX);
}

type ReviewInput = Pick<
  Run,
  "status" | "terminationReason" | "error" | "exitCode" | "humanIntervention" | "permissionDenials" | "contextExhausted"
> & { mcp?: Pick<RunMcpInfo, "allowListedMissing"> | null };

/** The rule. Call it on a terminal run; the stored `Run.reviewReasons` is what readers use. */
export function reviewReasons(run: ReviewInput): ReviewReason[] {
  // A person cancelled it, or it is still going: nothing to review, whatever the main
  // pass left behind (a cancel during the wrap-up keeps `budget_exhausted` and the exit code).
  if (run.status === "cancelled" || run.status === "running" || run.status === "pending") return [];
  const reasons: ReviewReason[] = [];
  if (isBudgetExhausted(run.terminationReason)) reasons.push("budget_exhausted");
  if (run.status === "timed_out") reasons.push("timed_out");
  if (isOrphaned(run)) reasons.push("orphaned");
  if (run.exitCode !== null && run.exitCode !== 0) reasons.push("nonzero_exit");
  if (run.status === "failed" && reasons.length === 0) reasons.push("failed");
  if (run.humanIntervention || (run.permissionDenials ?? 0) > 0) reasons.push("permission_denied");
  if (run.contextExhausted) reasons.push("context_exhausted");
  if ((run.mcp?.allowListedMissing ?? []).length > 0) reasons.push("mcp_missing");
  return reasons;
}

export function needsReview(run: ReviewInput): boolean {
  return reviewReasons(run).length > 0;
}

/** The columns a list or a schedule row needs to say how a run ended, without its result blobs. */
export type RunSummary = Pick<Run, "id" | "status" | "reviewReasons" | "terminationReason" | "costUsd" | "endedAt">;

/** What a schedule row says about the run it last started: enough to see a failure without opening it. */
export interface LastRunSummary {
  id: string;
  status: RunStatus;
  needsReview: boolean;
  reviewReasons: ReviewReason[];
  terminationReason: string | null;
  costUsd: number | null;
  endedAt: string | null;
}

export function lastRunSummary(run: RunSummary | null): LastRunSummary | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    needsReview: run.reviewReasons.length > 0,
    reviewReasons: run.reviewReasons,
    terminationReason: run.terminationReason,
    costUsd: run.costUsd,
    endedAt: run.endedAt,
  };
}

/** Compact view used by list_runs. */
export function summarizeRun(run: Run) {
  return {
    id: run.id,
    kind: run.kind,
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
    needsReview: run.reviewReasons.length > 0,
    reviewReasons: run.reviewReasons,
    humanIntervention: run.humanIntervention,
    contextExhausted: run.contextExhausted,
    terminationReason: run.terminationReason,
    /** Outcome and cost of the wrap-up pass after a budget exhaustion; null when there was none. */
    wrapUp: summarizeWrapUp(run),
    /** The run whose session this one resumed (on_failure: resume_once); null for a fresh run. */
    resumedFromRunId: run.resumedFromRunId,
    retries: run.retries,
    error: run.error,
  };
}

/** A run ended in a way `on_failure: resume_once` retries: out of budget or out of time, with a session to resume. */
export function isResumable(run: Pick<Run, "status" | "terminationReason" | "claudeSessionId">): boolean {
  if (!run.claudeSessionId) return false;
  return run.status === "timed_out" || (run.status === "failed" && isBudgetExhausted(run.terminationReason));
}

export function summarizeWrapUp(
  run: Pick<Run, "phases">,
): { outcome: RunPhase["outcome"]; costUsd: number | null; durationMs: number } | null {
  const w = wrapUpPhase(run);
  return w ? { outcome: w.outcome, costUsd: w.costUsd, durationMs: w.durationMs } : null;
}
