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
import type { ExecutionEvent, ExecutionHandle, ExecutionRequest, ExecutionResult, Executor, McpServerInfo, SubagentRecord } from "../execution/types.js";
import { isTerminal, type Run, type RunAgent, type RunStatus } from "../observability/run.js";
import type { RunRepository, ListRunsFilter } from "../storage/runs.js";
import { logger } from "../util/log.js";
import { validateProjectPath } from "./project-validation.js";
import { assertTransition } from "./run-state.js";
import { parseHolder, processIdentity } from "../scheduler/crud.js";

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

export interface RunManagerOptions {
  /** Owner recorded on every run, `role@host:pid` (processIdentity); defaults to role `unknown`. */
  owner?: string;
}

interface ActiveRun {
  handle: ExecutionHandle;
  agentId: string;
  projectPath: string;
  /** Allow-listed MCP entries, to compare with what actually mounted. */
  allowedTools: string[];
  mounted: McpServerInfo[];
  usedServers: Set<string>;
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
      log.warn("config reload failed; keeping previous config", { err: err instanceof Error ? err.message : String(err) });
    }
    return this._config;
  }

  /**
   * Mark `running` runs whose owning process is gone as failed. Called at startup and
   * by the scheduler lease holder. Several DuskFleet processes share the database
   * (serve, one MCP server per host session, CLI), so a run owned by a live process,
   * or by another host, is left alone.
   */
  recoverOrphans(): number {
    const orphans = this.runs.listByStatus("running").filter((run) => this.ownerIsGone(run));
    for (const run of orphans) {
      this.transition(run, "failed", {
        endedAt: new Date().toISOString(),
        error: `orphaned: owning process ${run.owner ?? "(unrecorded)"} is gone`,
      });
    }
    if (orphans.length) log.warn(`marked ${orphans.length} orphaned run(s) as failed`);
    return orphans.length;
  }

  /**
   * Gone = no owner recorded (legacy row), or an owner on this host whose pid is not
   * alive, or this very process without the run in memory (only after pid reuse).
   */
  private ownerIsGone(run: Run): boolean {
    if (run.owner === null) return true;
    const owner = parseHolder(run.owner);
    const self = parseHolder(this.owner);
    if (owner.host !== self.host) return false;
    if (owner.pid === null) return true;
    if (owner.pid === self.pid) return !this.active.has(run.id);
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (err) {
      // EPERM: alive, owned by another user. Only ESRCH proves it is gone.
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
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
    const maxBudgetUsd = agent.maxBudgetUsd ?? this.config.claude.defaultMaxBudgetUsd;
    const logPath = path.join(this.config.dataDir, "logs", `${runId}.jsonl`);

    const request: ExecutionRequest = {
      cwd: projectPath,
      prompt,
      sessionId,
      permissionMode: agent.permissionMode,
      timeoutMs: timeoutMinutes * 60_000,
      maxBudgetUsd,
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
      owner: this.owner,
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
    });
    this.transition(run, "running", { startedAt: new Date().toISOString(), command: handle.command });
    log.info("run started", { runId, agent: agent.id, cwd: projectPath, pid: handle.pid, model: model ?? "(default)" });

    void handle.done.then((result) => this.onFinished(runId, result));

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
    const handle = this.active.get(id)?.handle;
    if (handle && timeoutMs > 0) {
      await Promise.race([handle.done, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
      // Give the completion handler a tick to write the final state.
      await new Promise((r) => setImmediate(r));
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

  private onFinished(runId: string, result: ExecutionResult): void {
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
      });
      log.info("run finished", { runId, status: result.outcome, durationMs: result.durationMs, costUsd: result.costUsd });
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
        throw new Error(`unknown project "${projectIdOrNull}". Known projects: ${[...this.config.projects.keys()].join(", ")}`);
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
    this.runs.update(run.id, { ...patch, status: to });
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
