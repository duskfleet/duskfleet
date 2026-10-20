/**
 * RunManager ties everything together: validates input, creates the Run
 * record, launches the executor, tracks live processes, and writes results.
 *
 * It is deliberately the only place that mutates run status.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { listProjectAgents, projectAgentDefinitionHash } from "../config/agent-files.js";
import { loadConfig } from "../config/loader.js";
import type { AgentDefinition, DuskFleetConfig, ProjectDefinition } from "../config/types.js";
import { mergeSubagent, needsRepair, sameSubagent, subagentsFromLog } from "../execution/log-replay.js";
import { mergeUsageByModel } from "../execution/stream-json.js";
import {
  type ExecutionEvent,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type McpServerInfo,
  MIXED_MODEL,
  type SubagentRecord,
  type TokenUsage,
  type UsageByModel,
} from "../execution/types.js";
import {
  isBudgetExhausted,
  isResumable,
  isTerminal,
  orphanedError,
  type Run,
  type RunAgent,
  type RunKind,
  type RunPhase,
  type RunStatus,
  type RunSummary,
  reviewReasons,
} from "../observability/run.js";
import { parseHolder, processIdentity } from "../scheduler/crud.js";
import type { ListRunsFilter, RunRepository } from "../storage/runs.js";
import { logger } from "../util/log.js";
import { BusyError } from "./busy.js";
import { DailyCapError, dailyCapReason, utcDayStart } from "./daily-cap.js";
import { validateProjectPath } from "./project-validation.js";
import { assertTransition } from "./run-state.js";
import { summarizeToolInput } from "./tool-summary.js";

const log = logger("orchestration");

export interface StartRunInput {
  prompt: string;
  projectPath?: string;
  projectId?: string;
  agentId?: string;
  model?: string;
  /** Set by the scheduler. */
  scheduleId?: string;
  /** Internal: continue the session of an earlier run instead of starting a new one (see resumeRun). */
  resume?: { fromRun: Run; budgetUsd: number };
  /** `gate` for a schedule's gate agent (no wrap-up reserve, cost counted apart). Default `run`. */
  kind?: RunKind;
  /** Overrides the agent's max_budget_usd (gate runs). */
  maxBudgetUsd?: number;
}

export interface ResumeRunInput {
  /** The run whose session to continue; it must have ended budget_exhausted or timed_out and not been resumed before. */
  runId: string;
  scheduleId?: string;
  /** Budget of the resumed run; defaults to the agent's resume_budget_usd, else its max_budget_usd. */
  budgetUsd?: number;
}

/** What a resumed run is told. The session already holds the task and everything done so far. */
export function resumePrompt(reason: string): string {
  return (
    `Your previous session ended early (${reason}) before the task was finished. Continue from where you stopped: ` +
    "first check what was already done so you do not redo or undo it, then finish the task and record the outcome " +
    "where your instructions say. If it cannot be finished, record exactly where you stopped and why, then stop."
  );
}

export interface RunManagerOptions {
  /** Owner recorded on every run, `role@host:pid` (processIdentity); defaults to role `unknown`. */
  owner?: string;
}

interface ActiveRun {
  handle: ExecutionHandle;
  agentId: string;
  projectPath: string;
  /** The agent promised not to edit the project checkout: ignored by the per-project guard. */
  isolated: boolean;
  /** Allow-listed MCP entries, to compare with what actually mounted. */
  allowedTools: string[];
  mounted: McpServerInfo[];
  usedServers: Set<string>;
  /** The request of the main pass; the wrap-up pass is derived from it. */
  request: ExecutionRequest;
  /** Which process is running right now. */
  phase: RunPhase["phase"];
  /** Finished processes of this run, in order. */
  phases: RunPhase[];
  /** Dollars kept back for the wrap-up pass (0 = none). */
  reserveUsd: number;
  /** Result of the main pass while the wrap-up pass runs. */
  mainResult: ExecutionResult | null;
  /** cancel_run or shutdown() was called: never start a wrap-up pass after that, even if the main pass ended on its budget first. */
  cancelRequested: boolean;
  /** When the main pass was launched; the wrap-up pass only gets what is left of the run's timeout. */
  startedAtMs: number;
}

/** What the wrap-up pass is told. It must not start new work; it must leave a trace of where the run stopped. */
export const WRAP_UP_PROMPT =
  "Your budget is exhausted. Do not start new work or call subagents. Record exactly where you stopped and why, " +
  "in the place your instructions say (ticket comment, PR comment, or final message), then stop.";

/**
 * The wrap-up pass is short by design: at most this, and never more than what is left of
 * the run's own timeout (the run as a whole never outlasts `timeout_minutes`).
 */
const WRAP_UP_TIMEOUT_MS = 10 * 60_000;

/**
 * How a run's budget is split: the main pass gets `main`, the wrap-up pass (only after
 * a budget exhaustion) gets `reserve`. Default reserve: 10% of the budget, at least $0.50,
 * never more than half of it. An explicit `wrap_up_reserve_usd` is capped the same way; 0 disables.
 */
export function budgetPlan(
  agent: Pick<AgentDefinition, "maxBudgetUsd" | "wrapUpReserveUsd">,
  config: Pick<DuskFleetConfig, "claude">,
): { total: number; main: number; reserve: number } {
  const total = agent.maxBudgetUsd ?? config.claude.defaultMaxBudgetUsd;
  const wanted = agent.wrapUpReserveUsd ?? Math.max(0.5, total * 0.1);
  const reserve = wanted <= 0 ? 0 : round(Math.min(wanted, total / 2));
  return { total, main: round(total - reserve), reserve };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Event payload for a subagent start/end: enough to read the timeline without the row. */
function summarizeSubagent(s: SubagentRecord) {
  return {
    subagentType: s.subagentType,
    description: s.description,
    parentAgentId: s.parentAgentId,
    status: s.status,
    model: s.model,
    toolCalls: s.toolCalls,
    durationMs: s.durationMs,
  };
}

/** A path separator, a leading ~ or a drive letter: anything else given as a project path is a project id. */
function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || value.startsWith("~") || /^[A-Za-z]:/.test(value);
}

/** Claude Code derives MCP tool prefixes from the server name: "claude.ai Figma" → "mcp__claude_ai_Figma". */
export function mcpToolPrefix(serverName: string): string {
  return "mcp__" + serverName.replace(/[^A-Za-z0-9_-]/g, "_");
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();

  private _config: DuskFleetConfig;

  /** This process as `role@host:pid`, recorded as the owner of every run it starts. */
  readonly owner: string;

  constructor(
    config: DuskFleetConfig,
    private readonly runs: RunRepository,
    private readonly executor: Executor,
    options: RunManagerOptions = {},
  ) {
    this._config = config;
    this.owner = options.owner ?? processIdentity();
  }

  /** Current configuration. Call reloadConfig() first when freshness matters. */
  get config(): DuskFleetConfig {
    return this._config;
  }

  /**
   * Re-read config/ from disk so edits to agents, projects and duskfleet.yaml
   * apply without restarting the host process (Claude Desktop keeps the MCP
   * server alive for hours). On a parse error the previous config is kept and
   * the error is logged; a broken file must not take running agents down.
   */
  reloadConfig(): DuskFleetConfig {
    try {
      this._config = loadConfig(this._config.configDir);
    } catch (err) {
      log.warn("config reload failed; keeping previous config", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return this._config;
  }

  /** How the given runs ended (status, review reasons, cost), in one query: what a schedule row shows. */
  summaries(ids: string[]): RunSummary[] {
    return this.runs.summaries(ids);
  }

  /**
   * Mark `running` runs whose owning process is gone as failed. Called at startup and
   * by the scheduler lease holder. Several DuskFleet processes share the database
   * (serve, one MCP server per host session, CLI), so a run owned by a live process,
   * or by another host, is left alone.
   */
  recoverOrphans(): number {
    const orphans = this.runs.listByStatus("running").filter((run) => this.ownerIsGone(run));
    let recovered = 0;
    for (const run of orphans) {
      assertTransition(run.status, "failed");
      // Compare-and-set: a starting process and the lease holder may sweep the same row.
      const patch = {
        status: "failed" as const,
        endedAt: new Date().toISOString(),
        error: orphanedError(run.owner),
      };
      // Not through transition(): the write must stay a compare-and-set, so the reasons are computed here.
      const won = this.runs.updateIfStatus(run.id, "running", {
        ...patch,
        reviewReasons: reviewReasons({ ...run, ...patch }),
      });
      if (!won) continue;
      this.runs.addEvent(run.id, "status_change", { from: run.status, to: "failed" });
      recovered++;
    }
    if (recovered) log.warn(`marked ${recovered} orphaned run(s) as failed`);
    return recovered;
  }

  /**
   * Gone = no owner recorded and older than any run may live (see `legacyRunIsOver`), an
   * owner on this host without a usable pid or whose pid is not alive, or this very
   * process without the run in memory (only after pid reuse).
   */
  private ownerIsGone(run: Run): boolean {
    if (run.owner === null) return this.legacyRunIsOver(run);
    const owner = parseHolder(run.owner);
    const self = parseHolder(this.owner);
    if (owner.host !== self.host) return false;
    // pid 0 / negative would signal a process group and always "succeed".
    if (owner.pid === null || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    if (owner.pid === self.pid) return !this.active.has(run.id);
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (err) {
      // EPERM: alive, owned by another user. Only ESRCH proves it is gone.
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  /**
   * A row without owner comes from a build before run ownership, either from before the
   * upgrade or from a process still running that old build (a `serve` not restarted after
   * `npm run build`), whose run may be alive. It is over only once it started longer ago
   * than the longest configured timeout plus a minute: the executor kills a run at its
   * timeout, so nothing that old can still be running.
   */
  private legacyRunIsOver(run: Run): boolean {
    const started = Date.parse(run.startedAt ?? run.createdAt);
    if (Number.isNaN(started)) return true;
    let longest = this.config.claude.defaultTimeoutMinutes;
    for (const agent of this.config.agents.values()) longest = Math.max(longest, agent.timeoutMinutes ?? 0);
    return Date.now() - started > (longest + 1) * 60_000;
  }

  activeCount(): number {
    return this.active.size;
  }

  getRun(id: string): Run | null {
    return this.runs.get(id);
  }

  listRuns(filter: ListRunsFilter): Run[] {
    return this.runs.list(filter);
  }

  events(runId: string) {
    return this.runs.events(runId);
  }

  /** Subagent invocations recorded for a run (see RunAgent). A pure read. */
  agents(runId: string): RunAgent[] {
    return this.runs.agents(runId);
  }

  /**
   * One-shot backfill (CLI `repair-subagents`): subagent rows of finished runs that miss type,
   * brief, report or duration, still hold the raw hand-back frame, or were never closed, are
   * completed from the run's jsonl log with the current parser. Only terminal runs (status read
   * from the DB, so a run another process is still writing is never touched); a row is written
   * only when the merge changes it and the stored row is unchanged since it was read, so
   * re-running settles. A row still open after reading the log belongs to a run that ended
   * without closing it (orphan, crash) and becomes `interrupted`; with no log, it is left alone.
   */
  async repairSubagents(): Promise<{ runsChecked: number; rowsRepaired: number }> {
    let runsChecked = 0;
    let rowsRepaired = 0;
    for (const runId of this.runs.finishedRunIdsWithAgents()) {
      const run = this.runs.get(runId);
      if (!run || !isTerminal(run.status)) continue;
      const rows = this.runs.agents(runId).filter(needsRepair);
      if (!rows.length) continue;
      runsChecked += 1;
      const records = await subagentsFromLog(run.logPath);
      const fromLog = new Map((records ?? []).map((s) => [s.agentId, s]));
      // The replay awaited: re-read, and update only rows nobody wrote in the meantime.
      const current = new Map(this.runs.agents(runId).map((r) => [r.agentId, r]));
      for (const row of rows) {
        const now = current.get(row.agentId);
        if (!now || !sameSubagent(now, row)) continue;
        const { runId: _r, definitionHash, ...stored } = row;
        const merged = mergeSubagent(stored, fromLog.get(row.agentId));
        // Still open after reading the log: the run ended without closing it. With no log read
        // (missing or empty) nothing says so, and the row is left as it is.
        if (merged.status === "running" && records !== null) merged.status = "interrupted";
        // Closed, but the log gave no end time (no timestamp on the closing line): the run's end bounds it.
        if (merged.status !== "running") merged.endedAt ??= run.endedAt ?? new Date().toISOString();
        if (sameSubagent(stored, merged)) continue;
        this.runs.upsertAgent(runId, merged, definitionHash);
        rowsRepaired += 1;
      }
    }
    return { runsChecked, rowsRepaired };
  }

  /** The run that resumed `runId` (on_failure: resume_once), if any. */
  resumedBy(runId: string): Run | null {
    return this.runs.resumedBy(runId);
  }

  /** id → id of the resuming run, for the ids that have one (list views). */
  resumedByMany(ids: string[]): Map<string, string> {
    return this.runs.resumedByMany(ids);
  }

  /** Add a note to a run's timeline (the scheduler explains a fresh start after a refused resume). */
  note(runId: string, message: string): void {
    this.runs.addEvent(runId, "note", { message });
  }

  /**
   * Creates and launches a run. Returns as soon as the process has been
   * spawned; completion is observed via getRun()/waitForRun().
   */
  async startRun(input: StartRunInput): Promise<Run> {
    this.reloadConfig();
    const { agent, projectPath, projectId, project } = this.resolveTarget(input);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("prompt is empty");

    const busy = this.capacityError(agent, projectPath);
    if (busy) throw new BusyError(busy);
    const capped = this.dailyCapError(agent);
    if (capped) throw new DailyCapError(capped);

    const runId = randomUUID();
    const resume = input.resume ?? null;
    // A resumed run continues the earlier run's session under its own run id and log.
    const sessionId = resume?.fromRun.claudeSessionId ?? randomUUID();
    const model = input.model ?? agent.model;
    const timeoutMinutes = agent.timeoutMinutes ?? this.config.claude.defaultTimeoutMinutes;
    const kind: RunKind = input.kind ?? "run";
    const budgetAgent = resume
      ? { ...agent, maxBudgetUsd: resume.budgetUsd }
      : input.maxBudgetUsd !== undefined
        ? { ...agent, maxBudgetUsd: input.maxBudgetUsd }
        : agent;
    // A gate is a quick yes/no: no reserve, no wrap-up pass.
    const budget = budgetPlan(kind === "gate" ? { ...budgetAgent, wrapUpReserveUsd: 0 } : budgetAgent, this.config);
    const logPath = path.join(this.config.dataDir, "logs", `${runId}.jsonl`);

    const request: ExecutionRequest = {
      cwd: projectPath,
      prompt,
      sessionId,
      permissionMode: agent.permissionMode,
      timeoutMs: timeoutMinutes * 60_000,
      maxBudgetUsd: budget.main,
      logPath,
    };
    if (resume) request.resumeSessionId = sessionId;
    if (model) request.model = model;
    if (agent.allowedTools) request.allowedTools = agent.allowedTools;
    if (agent.disallowedTools) request.disallowedTools = agent.disallowedTools;
    if (agent.effort) request.effort = agent.effort;
    if (agent.systemPrompt) request.appendSystemPrompt = agent.systemPrompt;
    if (agent.inheritMcp || project?.inheritMcp) request.inheritMcp = true;
    if (agent.claudeAgent) {
      // Only project-level agents load under --setting-sources project,local; fail early with the real list.
      const available = listProjectAgents(projectPath).map((a) => a.name);
      if (!available.includes(agent.claudeAgent)) {
        throw new Error(
          `agent "${agent.id}" runs as project agent "${agent.claudeAgent}", but ${projectPath}/.claude/agents has ${available.length ? available.join(", ") : "no agents"}`,
        );
      }
      request.claudeAgent = agent.claudeAgent;
    }
    const addDirs = [...new Set([...(project?.addDirs ?? []), ...(agent.addDirs ?? [])])];
    if (addDirs.length) request.addDirs = addDirs;

    // Record the run (with the exact command) *before* launching it.
    const run: Run = {
      id: runId,
      agentId: agent.id,
      projectPath,
      projectId,
      prompt,
      modelRequested: input.model ?? null,
      modelUsed: null,
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      claudeSessionId: sessionId,
      permissionMode: agent.permissionMode,
      command: { binary: this.executor.binary, argv: [], cwd: projectPath },
      exitCode: null,
      terminationReason: null,
      error: null,
      resultText: null,
      numTurns: null,
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      usageByModel: null,
      costUsd: null,
      permissionDenials: null,
      deniedTools: [],
      mcp: { mounted: [], used: [], allowListedMissing: [] },
      humanIntervention: false,
      contextExhausted: false,
      retries: resume ? resume.fromRun.retries + 1 : 0,
      logPath,
      rawResultJson: null,
      scheduleId: input.scheduleId ?? null,
      owner: this.owner,
      phases: [],
      reviewReasons: [],
      resumedFromRunId: resume?.fromRun.id ?? null,
      kind,
    };

    // Insert first so that events emitted by the executor always find the row. For a resume the
    // insert is also the claim: resumed_from_run_id is unique (migration 8), so when two processes
    // race to resume the same run (a tick and run_schedule_now), the second insert fails here.
    try {
      this.runs.insert(run);
    } catch (err) {
      if (resume && /UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
        const other = this.runs.resumedBy(resume.fromRun.id);
        throw new Error(
          `run ${resume.fromRun.id} was already resumed once by run ${other?.id ?? "(unknown)"}; a second failure is final`,
        );
      }
      throw err;
    }
    this.runs.addEvent(runId, "status_change", { from: null, to: "pending" });
    if (resume) {
      this.runs.addEvent(runId, "note", {
        message: `resumes run ${resume.fromRun.id} (${resume.fromRun.status}, ${resume.fromRun.terminationReason ?? "no termination reason"}) with a ${budget.total} USD budget`,
        resumedFromRunId: resume.fromRun.id,
      });
    }

    let handle: ExecutionHandle;
    try {
      handle = this.executor.execute(request, (event) => this.onEvent(runId, event));
    } catch (err) {
      // e.g. bypassPermissions requested while disabled, or binary missing
      const message = err instanceof Error ? err.message : String(err);
      this.transition(run, "failed", { endedAt: new Date().toISOString(), error: message });
      if (resume) {
        // Nothing ran: give the claim back so the one retry is not used up by a spawn failure.
        this.runs.releaseResumeClaim(runId);
        this.runs.addEvent(runId, "note", {
          message: `resume of run ${resume.fromRun.id} did not start; the retry is still available`,
        });
      }
      throw err;
    }
    if (resume)
      this.runs.addEvent(resume.fromRun.id, "note", { message: `resumed by run ${runId}`, resumedByRunId: runId });

    this.active.set(runId, {
      handle,
      agentId: agent.id,
      projectPath,
      isolated: agent.isolated === true,
      allowedTools: agent.allowedTools ?? [],
      mounted: [],
      usedServers: new Set(),
      request,
      phase: "main",
      phases: [],
      reserveUsd: budget.reserve,
      mainResult: null,
      cancelRequested: false,
      startedAtMs: Date.now(),
    });
    this.transition(run, "running", { startedAt: new Date().toISOString(), command: handle.command });
    log.info("run started", {
      runId,
      agent: agent.id,
      cwd: projectPath,
      pid: handle.pid,
      model: model ?? "(default)",
      budgetUsd: budget.main,
      reserveUsd: budget.reserve,
    });

    void handle.done.then((result) => this.onPhaseFinished(runId, result));

    return this.runs.get(runId)!;
  }

  /**
   * Start a run that continues the session of a run that ended `budget_exhausted` or
   * `timed_out` (`on_failure: resume_once`). Same agent, project and envelope; the prompt
   * says to pick up where it stopped. Refused when the run cannot be resumed or already was:
   * a resume is tried once, a second failure is final.
   */
  async resumeRun(input: ResumeRunInput): Promise<Run> {
    const fromRun = this.runs.get(input.runId);
    if (!fromRun) throw new Error(`run not found: ${input.runId}`);
    if (!isResumable(fromRun)) {
      throw new Error(
        `run ${fromRun.id} cannot be resumed: it is ${fromRun.status}${fromRun.terminationReason ? ` (${fromRun.terminationReason})` : ""}; only budget_exhausted and timed_out runs with a session are`,
      );
    }
    if (fromRun.resumedFromRunId) {
      throw new Error(
        `run ${fromRun.id} is itself a resume of run ${fromRun.resumedFromRunId}; a resume is tried once, a second failure is final`,
      );
    }
    const already = this.runs.resumedBy(fromRun.id);
    if (already)
      throw new Error(
        `run ${fromRun.id} was already resumed once by run ${already.id} (${already.status}); a second failure is final`,
      );
    this.reloadConfig();
    const agent = this.resolveAgent(fromRun.agentId);
    const budgetUsd =
      input.budgetUsd ?? agent.resumeBudgetUsd ?? agent.maxBudgetUsd ?? this.config.claude.defaultMaxBudgetUsd;
    const reason = fromRun.status === "timed_out" ? "timed out" : "budget exhausted";
    // The original run's project: by id when it had one (the registry path may be a symlink of the resolved one).
    const startInput: StartRunInput = fromRun.projectId
      ? {
          prompt: resumePrompt(reason),
          agentId: fromRun.agentId,
          projectId: fromRun.projectId,
          resume: { fromRun, budgetUsd },
        }
      : {
          prompt: resumePrompt(reason),
          agentId: fromRun.agentId,
          projectPath: fromRun.projectPath,
          resume: { fromRun, budgetUsd },
        };
    if (fromRun.modelRequested) startInput.model = fromRun.modelRequested;
    if (input.scheduleId) startInput.scheduleId = input.scheduleId;
    return this.startRun(startInput);
  }

  cancelRun(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run not found: ${id}`);
    if (isTerminal(run.status)) return run;
    const active = this.active.get(id);
    if (active) {
      active.cancelRequested = true;
      active.handle.cancel(); // completion path will record `cancelled`
      this.runs.addEvent(id, "note", { message: "cancel requested" });
      return run;
    }
    // Another live DuskFleet process owns the claude child; writing `cancelled` here would
    // leave it running. It has to be cancelled through that process.
    if (!this.ownerIsGone(run)) {
      throw new Error(
        `run ${id} is owned by ${run.owner ?? "(unrecorded: an older DuskFleet build)"}, another live DuskFleet process; cancel it from there (or stop that process).`,
      );
    }
    // Not active and its owner is gone (orphan) – close it out directly
    this.transition(run, "cancelled", { endedAt: new Date().toISOString() });
    return this.runs.get(id)!;
  }

  /** Resolve when the run reaches a terminal state or the timeout elapses. */
  async waitForRun(id: string, timeoutMs: number): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    // A run can span more than one process (wrap-up pass): keep waiting while a new handle replaces the finished one.
    for (;;) {
      const handle = this.active.get(id)?.handle;
      const remaining = deadline - Date.now();
      if (!handle || remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        handle.done.then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), remaining);
        }),
      ]);
      clearTimeout(timer);
      // Give the completion handler a tick to write the final state (or start the next phase).
      await new Promise((r) => setImmediate(r));
      if (!finished || this.active.get(id)?.handle === handle) break;
    }
    return this.runs.get(id)!;
  }

  /** Terminate all live processes. Used on shutdown. */
  shutdown(): void {
    for (const [id, a] of this.active) {
      log.warn("shutdown: cancelling active run", { runId: id });
      a.cancelRequested = true;
      a.handle.cancel();
    }
  }

  /**
   * Why a run of this agent on this project would be refused right now (the WIP guards), or
   * null. Lets the scheduler skip a busy tick before it spends anything on a gate.
   */
  busyReason(input: { agentId: string; projectId?: string | null }): string | null {
    this.reloadConfig();
    const target: StartRunInput = { prompt: "", agentId: input.agentId };
    if (input.projectId) target.projectId = input.projectId;
    // Same resolution as startRun; an invalid target throws here rather than passing silently.
    const { agent, projectPath } = this.resolveTarget(target);
    return this.capacityError(agent, projectPath);
  }

  /**
   * Why a run of this agent would be refused by its daily caps right now, or null. Lets the
   * scheduler skip a capped tick before it spends anything on a gate.
   */
  dailyCapReason(agentId: string): string | null {
    this.reloadConfig();
    return this.dailyCapError(this.resolveAgent(agentId));
  }

  /**
   * The project directory a run of this agent would use, resolved exactly as startRun does
   * (schedule gates run their command there).
   */
  projectPathFor(input: { agentId: string; projectId?: string | null }): string {
    this.reloadConfig();
    const target: StartRunInput = { prompt: "", agentId: input.agentId };
    if (input.projectId) target.projectId = input.projectId;
    return this.resolveTarget(target).projectPath;
  }

  // ---- internals -----------------------------------------------------------

  /** Agent and project of a run: an agent bound to a project runs there by default and nowhere else. */
  private resolveTarget(input: StartRunInput): {
    agent: AgentDefinition;
    projectPath: string;
    projectId: string | null;
    project: ProjectDefinition | null;
  } {
    const agent = this.resolveAgent(input.agentId);
    const effectiveInput: StartRunInput =
      agent.project && !input.projectId && !input.projectPath ? { ...input, projectId: agent.project } : input;
    const { projectPath, projectId, project } = this.resolveProject(effectiveInput);
    if (agent.project && projectId !== agent.project) {
      throw new Error(
        `agent "${agent.id}" belongs to project "${agent.project}" and cannot run on ${projectId ? `"${projectId}"` : projectPath}. ` +
          `Omit the project to use the agent's own, or pick an agent without a project binding.`,
      );
    }
    return { agent, projectPath, projectId, project };
  }

  /** The WIP guards: why a run of `agent` in `projectPath` is refused right now, or null. */
  private capacityError(agent: AgentDefinition, projectPath: string): string | null {
    if (this.active.size >= this.config.maxConcurrentRuns) {
      return `max_concurrent_runs (${this.config.maxConcurrentRuns}) reached; wait for a run to finish`;
    }
    // Count this process's runs plus the live runs of other DuskFleet processes on the same database.
    const busy: Array<[string, { projectPath: string; agentId: string; isolated: boolean }]> = [
      ...this.active.entries(),
    ];
    for (const r of this.runs.listByStatus("running")) {
      if (!this.active.has(r.id) && !this.ownerIsGone(r)) {
        busy.push([r.id, { ...r, isolated: this.config.agents.get(r.agentId)?.isolated === true }]);
      }
    }
    // Isolated agents never edit the checkout: they neither count against nor wait for the
    // per-project limit. Only non-isolated runs compete for a working copy.
    if (!agent.isolated) {
      const sameProject = busy.filter(([, a]) => a.projectPath === projectPath && !a.isolated);
      if (sameProject.length >= this.config.maxConcurrentPerProject) {
        const [id, a] = sameProject[0]!;
        return (
          `project busy: run ${id} (agent ${a.agentId}) is still running in ${projectPath}. ` +
          `max_concurrent_per_project is ${this.config.maxConcurrentPerProject}; wait, cancel_run, or raise it ` +
          `(an agent that never edits the checkout can set isolated: true).`
        );
      }
    }
    const agentLimit = agent.maxConcurrent ?? this.config.maxConcurrentPerAgent;
    const sameAgent = busy.filter(([, a]) => a.agentId === agent.id).map(([id]) => id);
    if (sameAgent.length >= agentLimit) {
      const limitSource = agent.maxConcurrent !== undefined ? "its max_concurrent" : "max_concurrent_per_agent";
      return (
        `agent busy: agent ${agent.id} already has ${sameAgent.length} of ${agentLimit} runs (${sameAgent.join(", ")}). ` +
        `${limitSource} is ${agentLimit}; wait, cancel_run, or raise it.`
      );
    }
    return null;
  }

  /** The daily caps (max_daily_runs, max_daily_cost_usd, UTC day): why one more run is refused, or null. */
  private dailyCapError(agent: AgentDefinition): string | null {
    if (agent.maxDailyRuns === undefined && agent.maxDailyCostUsd === undefined) return null;
    return dailyCapReason(agent, this.runs.agentUsageSince(agent.id, utcDayStart(new Date())));
  }

  /**
   * A process of the run ended. The main pass that ran out of budget is followed by one
   * wrap-up pass on the same session (reserve budget, WRAP_UP_PROMPT); everything else
   * closes the run. The run's status is always the main pass's outcome, except that a
   * wrap-up pass cancelled by the user records the run as cancelled.
   */
  private onPhaseFinished(runId: string, result: ExecutionResult): void {
    const active = this.active.get(runId);
    if (!active) {
      this.onFinished(runId, result, [phaseOf("main", result, null)]);
      return;
    }
    const budgetUsd = active.phase === "main" ? (active.request.maxBudgetUsd ?? null) : active.reserveUsd;
    active.phases.push(phaseOf(active.phase, result, budgetUsd));
    const runOpen = !isTerminal(this.runs.get(runId)?.status ?? "failed");
    if (
      active.phase === "main" &&
      result.outcome === "failed" &&
      isBudgetExhausted(result.terminationReason) &&
      active.reserveUsd > 0 &&
      runOpen
    ) {
      // A cancel that raced the budget stop (the child had already exited) must still win.
      if (active.cancelRequested)
        this.runs.addEvent(runId, "note", { message: "wrap-up pass skipped: cancel requested" });
      else if (this.startWrapUp(runId, active, result)) return;
    }
    if (active.phase === "wrap_up" && active.mainResult) {
      this.runs.addEvent(runId, "phase", {
        phase: "wrap_up",
        status: "ended",
        outcome: result.outcome,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
      });
      this.onFinished(runId, mergeResults(active.mainResult, result), active.phases);
      return;
    }
    this.onFinished(runId, result, active.phases);
  }

  /** Resume the session with the reserve budget. Returns false when nothing could be started (the run then closes on the main result). */
  private startWrapUp(runId: string, active: ActiveRun, main: ExecutionResult): boolean {
    const runTimeoutMs = active.request.timeoutMs;
    const leftMs =
      runTimeoutMs && runTimeoutMs > 0 ? runTimeoutMs - (Date.now() - active.startedAtMs) : WRAP_UP_TIMEOUT_MS;
    if (leftMs <= 0) {
      this.runs.addEvent(runId, "note", { message: "wrap-up pass skipped: the run's timeout is used up" });
      return false;
    }
    const request: ExecutionRequest = {
      ...active.request,
      prompt: WRAP_UP_PROMPT,
      resumeSessionId: main.sessionId || active.request.sessionId,
      maxBudgetUsd: active.reserveUsd,
      timeoutMs: Math.min(leftMs, WRAP_UP_TIMEOUT_MS),
    };
    const couldNotStart = (reason: string) => {
      this.runs.addEvent(runId, "note", { message: `wrap-up pass could not start: ${reason}` });
      return false;
    };
    let handle: ExecutionHandle;
    try {
      handle = this.executor.execute(request, (event) => this.onEvent(runId, event));
    } catch (err) {
      // Executors may throw before spawning (startRun handles the same case).
      return couldNotStart(err instanceof Error ? err.message : String(err));
    }
    // ClaudeCodeExecutor does not throw on a spawn failure: it returns a handle without a pid
    // whose `done` resolves failed. That is not a wrap-up pass that ran; close on the main result.
    if (handle.pid === null) return couldNotStart("the process did not spawn (no pid)");
    this.runs.addEvent(runId, "phase", {
      phase: "wrap_up",
      status: "started",
      budgetUsd: active.reserveUsd,
      mainCostUsd: main.costUsd,
      reason: main.terminationReason,
    });
    active.handle = handle;
    active.phase = "wrap_up";
    active.mainResult = main;
    log.info("wrap-up pass started", {
      runId,
      pid: handle.pid,
      budgetUsd: active.reserveUsd,
      mainCostUsd: main.costUsd,
    });
    void handle.done.then((result) => this.onPhaseFinished(runId, result));
    return true;
  }

  private onFinished(runId: string, result: ExecutionResult, phases: RunPhase[]): void {
    const active = this.active.get(runId);
    this.active.delete(runId);
    try {
      const mcp = this.summarizeMcp(active);
      if (mcp.allowListedMissing.length) {
        this.runs.addEvent(runId, "note", {
          message: `allow-listed MCP servers never mounted in this run: ${mcp.allowListedMissing.join(", ")} (mounted: ${mcp.mounted.map((m) => mcpToolPrefix(m.name)).join(", ") || "none reported"})`,
        });
      }
      // Subagents still open when the process ended (cancel, timeout, crash) never handed back.
      for (const s of result.subagents) {
        if (s.endedAt !== null) continue;
        s.status = "interrupted";
        s.endedAt = result.endedAt;
        s.durationMs = Math.max(0, Date.parse(result.endedAt) - Date.parse(s.startedAt));
        this.runs.upsertAgent(runId, s, null);
        this.runs.addEvent(runId, "subagent_end", summarizeSubagent(s), s.agentId);
      }
      const current = this.runs.get(runId);
      if (!current) return;
      if (isTerminal(current.status)) {
        // Already closed out (e.g. marked orphaned after a pid reuse). Keep the first verdict.
        this.runs.addEvent(runId, "note", {
          message: `process exited after run was already ${current.status}`,
          outcome: result.outcome,
        });
        return;
      }
      this.transition(current, result.outcome, {
        endedAt: result.endedAt,
        durationMs: result.durationMs,
        modelUsed: result.model,
        claudeSessionId: result.sessionId,
        exitCode: result.exitCode,
        terminationReason: result.terminationReason,
        error: result.error,
        resultText: result.resultText,
        numTurns: result.numTurns,
        toolCalls: result.toolCalls,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        usageByModel: result.usageByModel,
        costUsd: result.costUsd,
        permissionDenials: result.permissionDenials,
        deniedTools: result.deniedTools,
        mcp,
        humanIntervention: result.permissionDenials > 0,
        contextExhausted: result.contextExhausted,
        rawResultJson: result.rawResult === null ? null : JSON.stringify(result.rawResult),
        phases,
      });
      log.info("run finished", {
        runId,
        status: result.outcome,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        phases: phases.length,
      });
    } catch (err) {
      log.error("failed to record run completion", { runId, err: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * What MCP looked like in this run. "Missing" = an allow-listed mcp__ entry whose
   * server prefix matches neither a mounted server nor a server actually called.
   * Mounted lists can be empty while connectors are still connecting at init, so a
   * prefix is only reported missing when the run gave us *some* MCP evidence.
   */
  private summarizeMcp(active: ActiveRun | undefined): import("../execution/types.js").RunMcpInfo {
    if (!active) return { mounted: [], used: [], allowListedMissing: [] };
    const used = [...active.usedServers].sort();
    const mountedPrefixes = new Set(active.mounted.map((m) => mcpToolPrefix(m.name)));
    const evidence = mountedPrefixes.size > 0 || used.length > 0;
    const allowListedPrefixes = new Set(
      active.allowedTools
        .filter((t) => t.startsWith("mcp__"))
        .map((t) => {
          const m = /^(mcp__[^_].*?)(?:__|$)/.exec(t);
          return m ? m[1]! : t;
        }),
    );
    const allowListedMissing = evidence
      ? [...allowListedPrefixes].filter((p) => !mountedPrefixes.has(p) && !used.includes(p)).sort()
      : [];
    return { mounted: active.mounted, used, allowListedMissing };
  }

  private resolveAgent(agentId: string | undefined): AgentDefinition {
    const id = agentId ?? this.config.defaultAgent;
    if (!id) {
      throw new Error(
        `no agent given and no default_agent in duskfleet.yaml. Known agents: ${[...this.config.agents.keys()].join(", ")}`,
      );
    }
    const agent = this.config.agents.get(id);
    if (!agent) {
      throw new Error(`unknown agent "${id}". Known agents: ${[...this.config.agents.keys()].join(", ")}`);
    }
    return agent;
  }

  private resolveProject(input: StartRunInput): {
    projectPath: string;
    projectId: string | null;
    project: ProjectDefinition | null;
  } {
    if (input.projectId && input.projectPath) {
      throw new Error("project_path and project_id are mutually exclusive");
    }
    // A project_path that is a registered id, or does not look like a path at all, is read as an id:
    // `my-app` works everywhere (MCP, CLI, scheduler) and a typo gets "unknown project", not "must be absolute".
    const projectIdOrNull =
      input.projectId ??
      (input.projectPath && (this.config.projects.has(input.projectPath) || !looksLikePath(input.projectPath))
        ? input.projectPath
        : null);
    if (projectIdOrNull) {
      const project = this.config.projects.get(projectIdOrNull);
      if (!project) {
        throw new Error(
          `unknown project "${projectIdOrNull}". Known projects: ${[...this.config.projects.keys()].join(", ")}`,
        );
      }
      return { projectPath: validateProjectPath(project.path, this.config), projectId: project.id, project };
    }
    if (input.projectPath) {
      const projectPath = validateProjectPath(input.projectPath, this.config);
      // A registered project reached by path still gets its settings.
      const project = [...this.config.projects.values()].find((p) => p.path === projectPath) ?? null;
      return { projectPath, projectId: project?.id ?? null, project };
    }
    throw new Error("either project_path or project_id is required");
  }

  private transition(run: Run, to: RunStatus, patch: Parameters<RunRepository["update"]>[1] = {}): void {
    assertTransition(run.status, to);
    const next = { ...patch, status: to };
    // The one place the needs-review rule runs: on the run as it will be stored, once terminal.
    if (isTerminal(to)) next.reviewReasons = reviewReasons({ ...run, ...defined(patch), status: to });
    this.runs.update(run.id, next);
    this.runs.addEvent(run.id, "status_change", { from: run.status, to });
    run.status = to;
  }

  private onEvent(runId: string, event: ExecutionEvent): void {
    switch (event.type) {
      case "init": {
        this.runs.update(
          runId,
          event.sessionId ? { claudeSessionId: event.sessionId, modelUsed: event.model } : { modelUsed: event.model },
        );
        const a = this.active.get(runId);
        if (a) a.mounted = event.mcpServers;
        this.runs.addEvent(runId, "init", {
          model: event.model,
          cliVersion: event.cliVersion,
          tools: event.tools.length,
          mcpServers: event.mcpServers.map((s) => `${s.name} (${s.status})`),
        });
        break;
      }
      case "tool_use": {
        const m = /^(mcp__[^_].*?)__/.exec(event.name);
        if (m) this.active.get(runId)?.usedServers.add(m[1]!);
        this.runs.addEvent(
          runId,
          "tool_use",
          { name: event.name, summary: summarizeToolInput(event.name, event.input) },
          event.agentId,
        );
        break;
      }
      case "subagent_start": {
        const s = event.subagent;
        const projectPath = this.active.get(runId)?.projectPath;
        const hash = projectPath ? projectAgentDefinitionHash(projectPath, s.subagentType) : null;
        this.runs.upsertAgent(runId, s, hash);
        this.runs.addEvent(runId, "subagent_start", summarizeSubagent(s), s.agentId);
        break;
      }
      case "subagent_end": {
        const s = event.subagent;
        this.runs.upsertAgent(runId, s, null);
        this.runs.addEvent(runId, "subagent_end", summarizeSubagent(s), s.agentId);
        break;
      }
      case "parse_error":
        this.runs.addEvent(runId, "error", { parseError: event.line });
        break;
      default:
        break; // assistant_text and stderr go to the log file only
    }
  }
}

function phaseOf(phase: RunPhase["phase"], r: ExecutionResult, budgetUsd: number | null): RunPhase {
  return {
    phase,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    outcome: r.outcome,
    terminationReason: r.terminationReason,
    budgetUsd,
    costUsd: r.costUsd,
    numTurns: r.numTurns,
    toolCalls: r.toolCalls,
  };
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * The run as one record: the main pass decides status, error and termination reason;
 * cost, turns, tool calls, tokens and denials are summed; the final text is the wrap-up's
 * (that is where the agent said where it stopped), falling back to the main pass's.
 */
/** A patch without its `undefined` entries, so spreading it over a run never erases a stored value. */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * One pass's per-model usage, so the merged map always sums to the merged totals: the
 * pass's own map when it has one, nothing when it spent no tokens, its totals under its
 * model when that model is known, otherwise "unknown" (undefined).
 */
function passUsageByModel(r: ExecutionResult): UsageByModel | null | undefined {
  if (r.usageByModel) return r.usageByModel;
  if (Object.values(r.usage).every((v) => v === null)) return null;
  if (r.model && r.model !== MIXED_MODEL) return { [r.model]: r.usage };
  return undefined;
}

export function mergeResults(main: ExecutionResult, wrapUp: ExecutionResult): ExecutionResult {
  const usage: TokenUsage = {
    inputTokens: addNullable(main.usage.inputTokens, wrapUp.usage.inputTokens),
    outputTokens: addNullable(main.usage.outputTokens, wrapUp.usage.outputTokens),
    cacheReadTokens: addNullable(main.usage.cacheReadTokens, wrapUp.usage.cacheReadTokens),
    cacheCreationTokens: addNullable(main.usage.cacheCreationTokens, wrapUp.usage.cacheCreationTokens),
  };
  // A pass whose tokens cannot be attributed to a model drops the map: a partial map
  // would no longer sum to the totals above.
  const mainByModel = passUsageByModel(main);
  const wrapUpByModel = passUsageByModel(wrapUp);
  const usageByModel =
    mainByModel === undefined || wrapUpByModel === undefined ? null : mergeUsageByModel(mainByModel, wrapUpByModel);
  return {
    ...main,
    outcome: wrapUp.outcome === "cancelled" ? "cancelled" : main.outcome,
    model: usageByModel && Object.keys(usageByModel).length > 1 ? MIXED_MODEL : (main.model ?? wrapUp.model),
    endedAt: wrapUp.endedAt,
    durationMs: Math.max(0, Date.parse(wrapUp.endedAt) - Date.parse(main.startedAt)),
    resultText: wrapUp.resultText ?? main.resultText,
    numTurns: addNullable(main.numTurns, wrapUp.numTurns),
    toolCalls: main.toolCalls + wrapUp.toolCalls,
    usage,
    usageByModel,
    costUsd: addNullable(main.costUsd, wrapUp.costUsd),
    permissionDenials: main.permissionDenials + wrapUp.permissionDenials,
    deniedTools: [...main.deniedTools, ...wrapUp.deniedTools],
    contextExhausted: main.contextExhausted || wrapUp.contextExhausted,
    subagents: [...main.subagents, ...wrapUp.subagents],
  };
}
