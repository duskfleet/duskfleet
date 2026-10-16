import type { DatabaseSync } from "node:sqlite";
import type { DeniedTool, RunMcpInfo, SubagentRecord, SubagentStatus } from "../execution/types.js";
import type { Run, RunAgent, RunEvent, RunStatus } from "../observability/run.js";

/** Row shape as SQLite returns it. */
interface RunRow {
  id: string;
  agent_id: string;
  project_path: string;
  project_id: string | null;
  prompt: string;
  model_requested: string | null;
  model_used: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  claude_session_id: string | null;
  permission_mode: string;
  command_json: string;
  exit_code: number | null;
  termination_reason: string | null;
  error: string | null;
  result_text: string | null;
  num_turns: number | null;
  tool_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  permission_denials: number | null;
  denied_tools_json: string | null;
  mcp_json: string | null;
  human_intervention: number;
  context_exhausted: number;
  retries: number;
  log_path: string | null;
  raw_result_json: string | null;
  schedule_id: string | null;
  owner: string | null;
}

function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    agentId: r.agent_id,
    projectPath: r.project_path,
    projectId: r.project_id,
    prompt: r.prompt,
    modelRequested: r.model_requested,
    modelUsed: r.model_used,
    status: r.status as RunStatus,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    claudeSessionId: r.claude_session_id,
    permissionMode: r.permission_mode,
    command: JSON.parse(r.command_json),
    exitCode: r.exit_code,
    terminationReason: r.termination_reason,
    error: r.error,
    resultText: r.result_text,
    numTurns: r.num_turns,
    toolCalls: r.tool_calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    costUsd: r.cost_usd,
    permissionDenials: r.permission_denials,
    deniedTools: safeParse(r.denied_tools_json),
    mcp: parseMcp(r.mcp_json),
    humanIntervention: r.human_intervention === 1,
    contextExhausted: r.context_exhausted === 1,
    retries: r.retries,
    logPath: r.log_path,
    rawResultJson: r.raw_result_json,
    scheduleId: r.schedule_id ?? null,
    owner: r.owner ?? null,
  };
}

export interface ListRunsFilter {
  status?: RunStatus;
  agentId?: string;
  projectPath?: string;
  limit?: number;
}

/** Fields that change after creation. Everything not listed is immutable. */
export type RunPatch = Partial<
  Pick<
    Run,
    | "status"
    | "startedAt"
    | "endedAt"
    | "durationMs"
    | "modelUsed"
    | "claudeSessionId"
    | "exitCode"
    | "terminationReason"
    | "error"
    | "resultText"
    | "numTurns"
    | "toolCalls"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheCreationTokens"
    | "costUsd"
    | "permissionDenials"
    | "deniedTools"
    | "mcp"
    | "humanIntervention"
    | "contextExhausted"
    | "retries"
    | "logPath"
    | "rawResultJson"
    | "command"
  >
>;

const PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  startedAt: "started_at",
  endedAt: "ended_at",
  durationMs: "duration_ms",
  modelUsed: "model_used",
  claudeSessionId: "claude_session_id",
  exitCode: "exit_code",
  terminationReason: "termination_reason",
  error: "error",
  resultText: "result_text",
  numTurns: "num_turns",
  toolCalls: "tool_calls",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens",
  cacheCreationTokens: "cache_creation_tokens",
  costUsd: "cost_usd",
  permissionDenials: "permission_denials",
  deniedTools: "denied_tools_json",
  mcp: "mcp_json",
  humanIntervention: "human_intervention",
  contextExhausted: "context_exhausted",
  retries: "retries",
  logPath: "log_path",
  rawResultJson: "raw_result_json",
  command: "command_json",
};

export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, project_path, project_id, prompt, model_requested, model_used, status,
           created_at, started_at, ended_at, duration_ms, claude_session_id, permission_mode, command_json,
           exit_code, termination_reason, error, result_text, num_turns, tool_calls, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, cost_usd, permission_denials, denied_tools_json, mcp_json, human_intervention,
           context_exhausted, retries, log_path, raw_result_json, schedule_id, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.agentId,
        run.projectPath,
        run.projectId,
        run.prompt,
        run.modelRequested,
        run.modelUsed,
        run.status,
        run.createdAt,
        run.startedAt,
        run.endedAt,
        run.durationMs,
        run.claudeSessionId,
        run.permissionMode,
        JSON.stringify(run.command),
        run.exitCode,
        run.terminationReason,
        run.error,
        run.resultText,
        run.numTurns,
        run.toolCalls,
        run.inputTokens,
        run.outputTokens,
        run.cacheReadTokens,
        run.cacheCreationTokens,
        run.costUsd,
        run.permissionDenials,
        JSON.stringify(run.deniedTools ?? []),
        JSON.stringify(run.mcp ?? EMPTY_MCP),
        run.humanIntervention ? 1 : 0,
        run.contextExhausted ? 1 : 0,
        run.retries,
        run.logPath,
        run.rawResultJson,
        run.scheduleId,
        run.owner,
      );
  }

  update(id: string, patch: RunPatch): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch) as Array<[keyof RunPatch, unknown]>) {
      if (value === undefined) continue;
      sets.push(`${PATCH_COLUMNS[key]} = ?`);
      if (typeof value === "boolean") values.push(value ? 1 : 0);
      else if (typeof value === "object" && value !== null) values.push(JSON.stringify(value));
      else values.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  get(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  list(filter: ListRunsFilter = {}): Run[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filter.status) {
      where.push("status = ?");
      values.push(filter.status);
    }
    if (filter.agentId) {
      where.push("agent_id = ?");
      values.push(filter.agentId);
    }
    if (filter.projectPath) {
      where.push("project_path = ?");
      values.push(filter.projectPath);
    }
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
    values.push(limit);
    const sql = `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...values) as unknown as RunRow[]).map(rowToRun);
  }

  listByStatus(status: RunStatus): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status = ?").all(status) as unknown as RunRow[]).map(rowToRun);
  }

  addEvent(runId: string, type: RunEvent["type"], payload: unknown, agentId: string | null = null): void {
    this.db
      .prepare("INSERT INTO run_events (run_id, ts, type, payload, agent_id) VALUES (?, ?, ?, ?, ?)")
      .run(runId, new Date().toISOString(), type, payload === undefined ? null : JSON.stringify(payload), agentId);
  }

  events(runId: string, limit = 200): RunEvent[] {
    const rows = this.db
      .prepare("SELECT id, run_id, ts, type, payload, agent_id FROM run_events WHERE run_id = ? ORDER BY id ASC LIMIT ?")
      .all(runId, limit) as Array<{ id: number; run_id: string; ts: string; type: RunEvent["type"]; payload: string | null; agent_id: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      type: r.type,
      payload: r.payload === null ? null : JSON.parse(r.payload),
      agentId: r.agent_id ?? null,
    }));
  }

  /** Insert or refresh one subagent invocation. Idempotent on (run_id, agent_id). */
  upsertAgent(runId: string, s: SubagentRecord, definitionHash: string | null): void {
    this.db
      .prepare(
        `INSERT INTO run_agents (run_id, agent_id, parent_tool_use_id, parent_agent_id, subagent_type, description, prompt,
           result_text, status, model, started_at, ended_at, duration_ms, tool_calls, tools_json,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, definition_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, agent_id) DO UPDATE SET
           parent_tool_use_id = excluded.parent_tool_use_id, parent_agent_id = excluded.parent_agent_id,
           subagent_type = excluded.subagent_type, description = excluded.description,
           prompt = COALESCE(excluded.prompt, run_agents.prompt), result_text = excluded.result_text,
           status = excluded.status, model = excluded.model, ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms, tool_calls = excluded.tool_calls, tools_json = excluded.tools_json,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens,
           total_tokens = excluded.total_tokens, started_at = excluded.started_at,
           definition_hash = COALESCE(excluded.definition_hash, run_agents.definition_hash)`,
      )
      .run(
        runId,
        s.agentId,
        s.parentToolUseId,
        s.parentAgentId,
        s.subagentType,
        s.description,
        s.prompt,
        s.resultText,
        s.status,
        s.model,
        s.startedAt,
        s.endedAt,
        s.durationMs,
        s.toolCalls,
        JSON.stringify(s.tools),
        s.usage.inputTokens,
        s.usage.outputTokens,
        s.usage.cacheReadTokens,
        s.usage.cacheCreationTokens,
        s.totalTokens,
        definitionHash,
      );
  }

  /** Subagent invocations of a run, in start order. */
  agents(runId: string): RunAgent[] {
    return (this.db.prepare("SELECT * FROM run_agents WHERE run_id = ? ORDER BY id ASC").all(runId) as unknown as RunAgentRow[]).map(rowToRunAgent);
  }
}

interface RunAgentRow {
  run_id: string;
  agent_id: string;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
  subagent_type: string;
  description: string | null;
  prompt: string | null;
  result_text: string | null;
  status: string;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  tool_calls: number;
  tools_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  total_tokens: number | null;
  definition_hash: string | null;
}

function rowToRunAgent(r: RunAgentRow): RunAgent {
  let tools: string[] = [];
  try {
    const v = JSON.parse(r.tools_json);
    if (Array.isArray(v)) tools = v.filter((t): t is string => typeof t === "string");
  } catch {
    /* keep [] */
  }
  return {
    runId: r.run_id,
    agentId: r.agent_id,
    parentToolUseId: r.parent_tool_use_id,
    parentAgentId: r.parent_agent_id,
    subagentType: r.subagent_type,
    description: r.description,
    prompt: r.prompt,
    resultText: r.result_text,
    status: r.status as SubagentStatus,
    model: r.model,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    toolCalls: r.tool_calls,
    tools,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
    },
    totalTokens: r.total_tokens,
    definitionHash: r.definition_hash,
  };
}

function safeParse(json: string | null): DeniedTool[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const EMPTY_MCP: RunMcpInfo = { mounted: [], used: [], allowListedMissing: [] };

function parseMcp(json: string | null): RunMcpInfo {
  if (!json) return { ...EMPTY_MCP };
  try {
    const v = JSON.parse(json) as Partial<RunMcpInfo>;
    return {
      mounted: Array.isArray(v.mounted) ? v.mounted : [],
      used: Array.isArray(v.used) ? v.used : [],
      allowListedMissing: Array.isArray(v.allowListedMissing) ? v.allowListedMissing : [],
    };
  } catch {
    return { ...EMPTY_MCP };
  }
}
