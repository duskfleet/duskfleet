/**
 * Parser for Claude Code's `--output-format stream-json` (one JSON object per line).
 *
 * Shapes verified against Claude Code 2.1.285 (subagent lines: 2.1.3xx, 2026-10-12):
 *   {"type":"system","subtype":"init","session_id","model","tools",...,"claude_code_version"}
 *   {"type":"assistant","message":{"id","model","usage",content:[{type:"text"|"tool_use",...}]},
 *      "parent_tool_use_id":null|string,"agent_id"?,"subagent_type"?,"timestamp"}
 *   {"type":"user", ...}                                     (tool results; same nesting fields)
 *   {"type":"system","subtype":"task_started","task_id","tool_use_id","description","subagent_type","prompt"}
 *   {"type":"system","subtype":"task_notification","task_id","tool_use_id","status","summary",
 *      "usage":{"total_tokens","tool_uses","duration_ms"}}
 *   {"type":"result","subtype","is_error","session_id","result","num_turns","duration_ms",
 *      "total_cost_usd","usage":{...},"modelUsage":{...},"permission_denials":[...],
 *      "terminal_reason","stop_reason"}
 *
 * Every message produced inside a subagent carries `agent_id` (= the task id) and
 * `parent_tool_use_id` (the Agent tool call in the parent). The main session has
 * `parent_tool_use_id: null` and no `agent_id`. The parent receives the subagent's
 * report as a normal `tool_result` for that tool_use id.
 *
 * Unknown fields and unknown line types are ignored so CLI upgrades degrade gracefully.
 */
import { summarizeToolInput } from "../orchestration/tool-summary.js";
import type { DeniedTool, ExecutionEvent, SubagentRecord, TokenUsage } from "./types.js";

export interface ParsedResult {
  isError: boolean;
  subtype: string | null;
  terminalReason: string | null;
  stopReason: string | null;
  sessionId: string | null;
  resultText: string | null;
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  usage: TokenUsage;
  permissionDenials: number;
  deniedTools: DeniedTool[];
  modelUsed: string | null;
  raw: unknown;
}

export interface StreamState {
  sessionId: string | null;
  /** Model of the main session. Subagents may run on another model; see SubagentRecord.model. */
  model: string | null;
  /** Tool calls across the whole run, subagents included. */
  toolCalls: number;
  /** Last text block of the main session (fallback when the result line is missing). */
  lastAssistantText: string | null;
  result: ParsedResult | null;
  parseErrors: number;
  /** Subagent invocations keyed by Claude Code task id, in start order. */
  subagents: Map<string, SubagentRecord>;
  /** tool_use id → agent id of the message that issued it (null = main session). Resolves nesting. */
  toolUseOwner: Map<string, string | null>;
  /** API message ids whose usage was already counted (one response is streamed as several lines). */
  countedMessages: Set<string>;
  /** Subagents whose startedAt was taken from a stream timestamp. */
  stamped: Set<string>;
}

export function createStreamState(): StreamState {
  return {
    sessionId: null,
    model: null,
    toolCalls: 0,
    lastAssistantText: null,
    result: null,
    parseErrors: 0,
    subagents: new Map(),
    toolUseOwner: new Map(),
    countedMessages: new Set(),
    stamped: new Set(),
  };
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function emptyUsage(): TokenUsage {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
}
function addUsage(into: TokenUsage, usage: Json): void {
  const add = (key: keyof TokenUsage, field: string) => {
    const v = num(usage[field]);
    if (v !== null) into[key] = (into[key] ?? 0) + v;
  };
  add("inputTokens", "input_tokens");
  add("outputTokens", "output_tokens");
  add("cacheReadTokens", "cache_read_input_tokens");
  add("cacheCreationTokens", "cache_creation_input_tokens");
}

/** Feed one line. Returns the structured events it produced (may be empty). */
export function ingestLine(state: StreamState, line: string): ExecutionEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    state.parseErrors += 1;
    return [{ type: "parse_error", line: trimmed.slice(0, 500) }];
  }
  if (!isObject(msg)) return [];

  const events: ExecutionEvent[] = [];
  switch (msg["type"]) {
    case "system": {
      switch (msg["subtype"]) {
        case "init": {
          state.sessionId = str(msg["session_id"]) ?? state.sessionId;
          state.model = str(msg["model"]) ?? state.model;
          const tools = Array.isArray(msg["tools"])
            ? msg["tools"].filter((t): t is string => typeof t === "string")
            : [];
          // Connectors may still be connecting at init time (list seen empty while MCP tools were later used).
          const mcpServers = (Array.isArray(msg["mcp_servers"]) ? msg["mcp_servers"] : [])
            .filter(isObject)
            .map((s) => ({ name: str(s["name"]) ?? "unknown", status: str(s["status"]) ?? "unknown" }));
          events.push({
            type: "init",
            sessionId: state.sessionId ?? "",
            model: state.model,
            tools,
            mcpServers,
            cliVersion: str(msg["claude_code_version"]),
          });
          break;
        }
        case "task_started": {
          const agentId = str(msg["task_id"]);
          if (!agentId) break;
          const record = subagentFor(
            state,
            agentId,
            msg["tool_use_id"],
            msg["subagent_type"],
            msg["description"],
            events,
          );
          if (record.prompt === null) record.prompt = str(msg["prompt"]);
          break;
        }
        case "task_progress": {
          const record = state.subagents.get(str(msg["task_id"]) ?? "");
          const usage = isObject(msg["usage"]) ? msg["usage"] : {};
          if (record) record.totalTokens = num(usage["total_tokens"]) ?? record.totalTokens;
          break;
        }
        case "task_notification": {
          // Status and a summary of the hand-back. The parent's tool_result (next line) carries the full text.
          const record = state.subagents.get(str(msg["task_id"]) ?? "");
          if (!record) break;
          const status = str(msg["status"]);
          if (status === "failed" || status === "error") record.status = "failed";
          else if (status) record.status = "completed";
          const usage = isObject(msg["usage"]) ? msg["usage"] : {};
          record.durationMs = num(usage["duration_ms"]) ?? record.durationMs;
          record.totalTokens = num(usage["total_tokens"]) ?? record.totalTokens;
          if (record.resultText === null) record.resultText = str(msg["summary"]);
          break;
        }
        default:
          break;
      }
      break;
    }
    case "assistant": {
      const message = msg["message"];
      if (!isObject(message)) break;
      const agentId = nestedAgent(state, msg, events);
      const model = str(message["model"]);
      const record = agentId ? state.subagents.get(agentId) : undefined;
      if (model && model !== "<synthetic>") {
        if (record) record.model = model;
        else if (!agentId) state.model = model;
      }
      const messageId = str(message["id"]);
      if (isObject(message["usage"]) && record && (!messageId || !state.countedMessages.has(messageId))) {
        if (messageId) state.countedMessages.add(messageId);
        addUsage(record.usage, message["usage"]);
      }
      const content = message["content"];
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block["type"] === "tool_use") {
          state.toolCalls += 1;
          const name = str(block["name"]) ?? "unknown";
          const id = str(block["id"]);
          if (id) state.toolUseOwner.set(id, agentId);
          if (record) {
            record.toolCalls += 1;
            if (!record.tools.includes(name)) record.tools.push(name);
          }
          events.push({ type: "tool_use", name, id, input: block["input"], agentId });
        } else if (block["type"] === "text") {
          const text = str(block["text"]);
          if (text) {
            if (!agentId) state.lastAssistantText = text;
            events.push({ type: "assistant_text", text, agentId });
          }
        }
      }
      break;
    }
    case "user": {
      const agentId = nestedAgent(state, msg, events);
      const message = msg["message"];
      if (!isObject(message)) break;
      const content = message["content"];
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block["type"] === "text" && agentId) {
          // The first user message inside a subagent is the brief it received.
          const record = state.subagents.get(agentId);
          if (record && record.prompt === null) record.prompt = str(block["text"]);
        } else if (block["type"] === "tool_result") {
          // The hand-back: a tool_result for the Agent call that spawned a subagent closes it.
          const toolUseId = str(block["tool_use_id"]);
          const record = toolUseId
            ? [...state.subagents.values()].find((s) => s.parentToolUseId === toolUseId)
            : undefined;
          if (!record || record.endedAt !== null) continue;
          const text = toolResultText(block["content"]);
          if (text) record.resultText = text;
          if (record.status === "running") record.status = "completed";
          record.endedAt = str(msg["timestamp"]) ?? new Date().toISOString();
          if (record.durationMs === null)
            record.durationMs = Math.max(0, Date.parse(record.endedAt) - Date.parse(record.startedAt));
          events.push({ type: "subagent_end", subagent: record });
        }
      }
      break;
    }
    case "result": {
      state.result = parseResult(msg);
      if (state.result.sessionId) state.sessionId = state.result.sessionId;
      break;
    }
    default:
      break;
  }
  return events;
}

/**
 * Agent id of a nested message, registering the subagent on first sight when the
 * `task_started` line was missing (older CLIs). Null for the main session.
 */
function nestedAgent(state: StreamState, msg: Json, events: ExecutionEvent[]): string | null {
  const agentId = str(msg["agent_id"]);
  if (!agentId) return null;
  const record = subagentFor(
    state,
    agentId,
    msg["parent_tool_use_id"],
    msg["subagent_type"],
    msg["task_description"],
    events,
  );
  // task_started lines carry no timestamp; the first nested message does. Prefer stream time over wall-clock time.
  const ts = str(msg["timestamp"]);
  if (ts && !state.stamped.has(agentId)) {
    record.startedAt = ts;
    state.stamped.add(agentId);
  }
  return agentId;
}

function subagentFor(
  state: StreamState,
  agentId: string,
  parentToolUseId: unknown,
  subagentType: unknown,
  description: unknown,
  events: ExecutionEvent[],
): SubagentRecord {
  let record = state.subagents.get(agentId);
  if (record) return record;
  const parent = str(parentToolUseId);
  record = {
    agentId,
    parentToolUseId: parent,
    parentAgentId: parent ? (state.toolUseOwner.get(parent) ?? null) : null,
    subagentType: str(subagentType) ?? "unknown",
    description: str(description),
    prompt: null,
    resultText: null,
    status: "running",
    model: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    toolCalls: 0,
    tools: [],
    usage: emptyUsage(),
    totalTokens: null,
  };
  state.subagents.set(agentId, record);
  events.push({ type: "subagent_start", subagent: record });
  return record;
}

/** Text of a tool_result: a plain string or an array of text blocks. */
function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(isObject)
    .map((b) => (b["type"] === "text" ? str(b["text"]) : null))
    .filter((t): t is string => !!t);
  return parts.length ? parts.join("\n") : null;
}

function parseResult(msg: Json): ParsedResult {
  const usage = isObject(msg["usage"]) ? msg["usage"] : {};
  const deniedTools: DeniedTool[] = (Array.isArray(msg["permission_denials"]) ? msg["permission_denials"] : [])
    .filter(isObject)
    .map((d) => {
      const tool = str(d["tool_name"]) ?? "unknown";
      return { tool, summary: summarizeToolInput(tool, d["tool_input"]) };
    });
  const denials = deniedTools.length;

  // modelUsage is keyed by model id; when exactly one model was used, report it.
  let modelUsed: string | null = null;
  if (isObject(msg["modelUsage"])) {
    const keys = Object.keys(msg["modelUsage"]);
    if (keys.length >= 1) modelUsed = keys.join(",");
  }

  return {
    isError: msg["is_error"] === true,
    subtype: str(msg["subtype"]),
    terminalReason: str(msg["terminal_reason"]),
    stopReason: str(msg["stop_reason"]),
    sessionId: str(msg["session_id"]),
    resultText: str(msg["result"]),
    numTurns: num(msg["num_turns"]),
    durationMs: num(msg["duration_ms"]),
    costUsd: num(msg["total_cost_usd"]),
    usage: {
      inputTokens: num(usage["input_tokens"]),
      outputTokens: num(usage["output_tokens"]),
      cacheReadTokens: num(usage["cache_read_input_tokens"]),
      cacheCreationTokens: num(usage["cache_creation_input_tokens"]),
    },
    permissionDenials: denials,
    deniedTools,
    modelUsed,
    raw: msg,
  };
}

/**
 * Only structured signals count: terminal reason, result subtype, stop reason, and
 * the result text *when the run is an error*. Scanning a successful run's prose
 * produced false positives (a reviewer writing "context" and "limitation" was
 * flagged on 2026-10-08).
 */
export function looksLikeContextExhaustion(result: ParsedResult | null): boolean {
  if (!result) return false;
  const structured = [result.terminalReason, result.subtype, result.stopReason]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase();
  if (/context[_ ]?(window|limit|exhaust)|prompt[_ ]too[_ ]long|max_turns|max_tokens/.test(structured)) return true;
  if (result.isError && result.resultText) {
    const err = result.resultText.slice(0, 500).toLowerCase();
    return err.includes("prompt is too long") || err.includes("context window") || err.includes("context limit");
  }
  return false;
}
