/**
 * RunManager ties everything together: validates input, creates the Run
 * record, launches the executor, tracks live processes, and writes results.
 *
 * It is deliberately the only place that mutates run status.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { listProjectAgents, projectAgentDefinitionHash } from "../config/agent-files.js";
import { summarizeToolInput } from "./tool-summary.js";
import type { AgentDefinition, DuskFleetConfig, ProjectDefinition } from "../config/types.js";
import type { ExecutionEvent, ExecutionHandle, ExecutionRequest, ExecutionResult, Executor, McpServerInfo, SubagentRecord, TokenUsage } from "../execution/types.js";
import { isBudgetExhausted, isTerminal, ORPHANED_ERROR, reviewReasons, type Run, type RunAgent, type RunPhase, type RunStatus, type RunSummary } from "../observability/run.js";
import type { RunRepository, ListRunsFilter } from "../storage/runs.js";
import { logger } from "../util/log.js";
import { validateProjectPath } from "./project-validation.js";
import { assertTransition } from "./run-state.js";

const log = logger("orchestration");

export interface StartRunInput {
  prompt: string;
  projectPath?: string;
  projectId?: string;
  agentId?: string;
  model?: string;
  /** Set by the scheduler. */
  scheduleId?: string;
}

interface ActiveRun {
  handle: ExecutionHandle;
  agentId: string;
  projectPath: string;
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
}

/** What the wrap-up pass is told. It must not start new work; it must leave a trace of where the run stopped. */
export const WRAP_UP_PROMPT =
  "Your budget is exhausted. Do not start new work or call subagents. Record exactly where you stopped and why, " +
  "in the place your instructions say (ticket comment, PR comment, or final message), then stop.";

/** The wrap-up pass is short by design; it never gets more time than the run itself. */
const WRAP_UP_TIMEOUT_MS = 10 * 60_000;

/**
 * How a run's budget is split: the main pass gets `main`, the wrap-up pass (only after
 * a budget exhaustion) gets `reserve`. Default reserve: 10% of the budget, at least $0.50,
 * never more than half of it. An explicit `wrap_up_reserve_usd` is capped the same way; 0 disables.
 */
export function budgetPlan(agent: Pick<AgentDefinition, "maxBudgetUsd" | "wrapUpReserveUsd">, config: Pick<DuskFleetConfig, "claude">): { total: number; main: number; reserve: number } {
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

/** Claude Code derives MCP tool prefixes from the server name: "claude.ai Figma" → "mcp__claude_ai_Figma". */
export function mcpToolPrefix(serverName: string): string {
  return "mcp__" + serverName.replace(/[^A-Za-z0-9_-]/g, "_");
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();

  private _config: DuskFleetConfig;

  constructor(
    config: DuskFleetConfig,
    private readonly runs: RunRepository,
    private readonly executor: Executor,
  ) {
    this._config = config;
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
      log.warn("config reload failed; keeping previous config", { err: err instanceof Error ? err.message : String(err) });
    }
    return this._config;
  }

  /** How the given runs ended (status, review reasons, cost), in one query: what a schedule row shows. */
  summaries(ids: string[]): RunSummary[] {
    return this.runs.summaries(ids);
  }

  /** Mark runs left in `running` by a previous process as failed. Call once at startup. */
  recoverOrphans(): number {
    const orphans = this.runs.listByStatus("running");
    for (const run of orphans) {
      this.transition(run, "failed", { endedAt: new Date().toISOString(), error: ORPHANED_ERROR });
    }
    if (orphans.length) log.warn(`marked ${orphans.length} orphaned run(s) as failed`);
    return orphans.length;
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

  /** Subagent invocations recorded for a run (see RunAgent). */
  agents(runId: string): RunAgent[] {
    return this.runs.agents(runId);
  }

  /**
   * Creates and launches a run. Returns as soon as the process has been
   * spawned; completion is observed via getRun()/waitForRun().
   */
  async startRun(input: StartRunInput): Promise<Run> {
    this.reloadConfig();
    const agent = this.resolveAgent(input.agentId);
    // An agent bound to a project runs there by default and nowhere else.
    const effectiveInput: StartRunInput =
      agent.project && !input.projectId && !input.projectPath ? { ...input, projectId: agent.project } : input;
    const { projectPath, projectId, project } = this.resolveProject(effectiveInput);
    if (agent.project && projectId !== agent.project) {
      throw new Error(
        `agent "${agent.id}" belongs to project "${agent.project}" and cannot run on ${projectId ? `"${projectId}"` : projectPath}. ` +
          `Omit the project to use the agent's own, or pick an agent without a project binding.`,
      );
    }
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("prompt is empty");

    if (this.active.size >= this.config.maxConcurrentRuns) {
      throw new Error(`max_concurrent_runs (${this.config.maxConcurrentRuns}) reached; wait for a run to finish`);
    }
    const sameProject = [...this.active.entries()].filter(([, a]) => a.projectPath === projectPath);
    if (sameProject.length >= this.config.maxConcurrentPerProject) {
      const [id, a] = sameProject[0]!;
      throw new Error(
        `project busy: run ${id} (agent ${a.agentId}) is still running in ${projectPath}. ` +
          `max_concurrent_per_project is ${this.config.maxConcurrentPerProject}; wait, cancel_run, or raise it.`,
      );
    }
    const sameAgent = [...this.active.entries()].filter(([, a]) => a.agentId === agent.id);
    if (sameAgent.length >= this.config.maxConcurrentPerAgent) {
      const [id] = sameAgent[0]!;
      throw new Error(
        `agent busy: ${agent.id} is still running (run ${id}). max_concurrent_per_agent is ${this.config.maxConcurrentPerAgent}; the tick is skipped.`,
      );
    }

    const runId = randomUUID();
    const sessionId = randomUUID();
    const model = input.model ?? agent.model;
    const timeoutMinutes = agent.timeoutMinutes ?? this.config.claude.defaultTimeoutMinutes;
    const budget = budgetPlan(agent, this.config);
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
      costUsd: null,
      permissionDenials: null,
      deniedTools: [],
      mcp: { mounted: [], used: [], allowListedMissing: [] },
      humanIntervention: false,
      contextExhausted: false,
      retries: 0,
      logPath,
      rawResultJson: null,
      scheduleId: input.scheduleId ?? null,
      phases: [],
      reviewReasons: [],
    };

    // Insert first so that events emitted by the executor always find the row.
    this.runs.insert(run);
    this.runs.addEvent(runId, "status_change", { from: null, to: "pending" });

    let handle: ExecutionHandle;
    try {
      handle = this.executor.execute(request, (event) => this.onEvent(runId, event));
    } catch (err) {
      // e.g. bypassPermissions requested while disabled, or binary missing
      const message = err instanceof Error ? err.message : String(err);
      this.transition(run, "failed", { endedAt: new Date().toISOString(), error: message });
      throw err;
    }

    this.active.set(runId, {
      handle,
      agentId: agent.id,
      projectPath,
      allowedTools: agent.allowedTools ?? [],
      mounted: [],
      usedServers: new Set(),
      request,
      phase: "main",
      phases: [],
      reserveUsd: budget.reserve,
      mainResult: null,
    });
    this.transition(run, "running", { startedAt: new Date().toISOString(), command: handle.command });
    log.info("run started", { runId, agent: agent.id, cwd: projectPath, pid: handle.pid, model: model ?? "(default)", budgetUsd: budget.main, reserveUsd: budget.reserve });

    void handle.done.then((result) => this.onPhaseFinished(runId, result));

    return this.runs.get(runId)!;
  }

  cancelRun(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run not found: ${id}`);
    if (isTerminal(run.status)) return run;
    const active = this.active.get(id);
    if (active) {
      active.handle.cancel(); // completion path will record `cancelled`
      this.runs.addEvent(id, "note", { message: "cancel requested" });
      return run;
    }
    // pending but not active (should not happen) – close it out directly
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
      a.handle.cancel();
    }
  }

  // ---- internals -----------------------------------------------------------

  /**
   * A process of the run ended. The main pass that ran out of budget is followed by one
   * wrap-up pass on the same session (reserve budget, WRAP_UP_PROMPT); everything else
   * closes the run. The run's status is always the main pass's outcome, except that a
   * wrap-up pass cancelled by the user records the run as cancelled.
   */
  private onPhaseFinished(runId: string, result: ExecutionResult): void {
    const active = this.active.get(runId);
    if (!active) return this.onFinished(runId, result, [phaseOf("main", result, null)]);
    const budgetUsd = active.phase === "main" ? (active.request.maxBudgetUsd ?? null) : active.reserveUsd;
    active.phases.push(phaseOf(active.phase, result, budgetUsd));
    const runOpen = !isTerminal(this.runs.get(runId)?.status ?? "failed");
    if (active.phase === "main" && result.outcome === "failed" && isBudgetExhausted(result.terminationReason) && active.reserveUsd > 0 && runOpen) {
      if (this.startWrapUp(runId, active, result)) return;
    }
    if (active.phase === "wrap_up" && active.mainResult) {
      this.runs.addEvent(runId, "phase", { phase: "wrap_up", status: "ended", outcome: result.outcome, costUsd: result.costUsd, durationMs: result.durationMs, numTurns: result.numTurns });
      return this.onFinished(runId, mergeResults(active.mainResult, result), active.phases);
    }
    this.onFinished(runId, result, active.phases);
  }

  /** Resume the session with the reserve budget. Returns false when nothing could be started (the run then closes on the main result). */
  private startWrapUp(runId: string, active: ActiveRun, main: ExecutionResult): boolean {
    const request: ExecutionRequest = {
      ...active.request,
      prompt: WRAP_UP_PROMPT,
      resumeSessionId: main.sessionId || active.request.sessionId,
      maxBudgetUsd: active.reserveUsd,
      timeoutMs: Math.min(active.request.timeoutMs ?? WRAP_UP_TIMEOUT_MS, WRAP_UP_TIMEOUT_MS),
    };
    this.runs.addEvent(runId, "phase", { phase: "wrap_up", status: "started", budgetUsd: active.reserveUsd, mainCostUsd: main.costUsd, reason: main.terminationReason });
    let handle: ExecutionHandle;
    try {
      handle = this.executor.execute(request, (event) => this.onEvent(runId, event));
    } catch (err) {
      this.runs.addEvent(runId, "note", { message: `wrap-up pass could not start: ${err instanceof Error ? err.message : String(err)}` });
      return false;
    }
    active.handle = handle;
    active.phase = "wrap_up";
    active.mainResult = main;
    log.info("wrap-up pass started", { runId, pid: handle.pid, budgetUsd: active.reserveUsd, mainCostUsd: main.costUsd });
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
        // Already closed out (e.g. marked orphaned/failed by a restart). Keep the first verdict.
        this.runs.addEvent(runId, "note", { message: `process exited after run was already ${current.status}`, outcome: result.outcome });
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
        costUsd: result.costUsd,
        permissionDenials: result.permissionDenials,
        deniedTools: result.deniedTools,
        mcp,
        humanIntervention: result.permissionDenials > 0,
        contextExhausted: result.contextExhausted,
        rawResultJson: result.rawResult === null ? null : JSON.stringify(result.rawResult),
        phases,
      });
      log.info("run finished", { runId, status: result.outcome, durationMs: result.durationMs, costUsd: result.costUsd, phases: phases.length });
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
      throw new Error(`no agent given and no default_agent in duskfleet.yaml. Known agents: ${[...this.config.agents.keys()].join(", ")}`);
    }
    const agent = this.config.agents.get(id);
    if (!agent) {
      throw new Error(`unknown agent "${id}". Known agents: ${[...this.config.agents.keys()].join(", ")}`);
    }
    return agent;
  }

  private resolveProject(input: StartRunInput): { projectPath: string; projectId: string | null; project: ProjectDefinition | null } {
    if (input.projectId) {
      const project = this.config.projects.get(input.projectId);
      if (!project) {
        throw new Error(`unknown project "${input.projectId}". Known projects: ${[...this.config.projects.keys()].join(", ")}`);
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
        this.runs.update(runId, event.sessionId ? { claudeSessionId: event.sessionId, modelUsed: event.model } : { modelUsed: event.model });
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
        this.runs.addEvent(runId, "tool_use", { name: event.name, summary: summarizeToolInput(event.name, event.input) }, event.agentId);
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

export function mergeResults(main: ExecutionResult, wrapUp: ExecutionResult): ExecutionResult {
  const usage: TokenUsage = {
    inputTokens: addNullable(main.usage.inputTokens, wrapUp.usage.inputTokens),
    outputTokens: addNullable(main.usage.outputTokens, wrapUp.usage.outputTokens),
    cacheReadTokens: addNullable(main.usage.cacheReadTokens, wrapUp.usage.cacheReadTokens),
    cacheCreationTokens: addNullable(main.usage.cacheCreationTokens, wrapUp.usage.cacheCreationTokens),
  };
  return {
    ...main,
    outcome: wrapUp.outcome === "cancelled" ? "cancelled" : main.outcome,
    model: main.model ?? wrapUp.model,
    endedAt: wrapUp.endedAt,
    durationMs: Math.max(0, Date.parse(wrapUp.endedAt) - Date.parse(main.startedAt)),
    resultText: wrapUp.resultText ?? main.resultText,
    numTurns: addNullable(main.numTurns, wrapUp.numTurns),
    toolCalls: main.toolCalls + wrapUp.toolCalls,
    usage,
    costUsd: addNullable(main.costUsd, wrapUp.costUsd),
    permissionDenials: main.permissionDenials + wrapUp.permissionDenials,
    deniedTools: [...main.deniedTools, ...wrapUp.deniedTools],
    contextExhausted: main.contextExhausted || wrapUp.contextExhausted,
    subagents: [...main.subagents, ...wrapUp.subagents],
  };
}
