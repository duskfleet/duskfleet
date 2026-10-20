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
import {
  type DeniedTool,
  type ExecutionEvent,
  MIXED_MODEL,
  type SubagentRecord,
  type TokenUsage,
  type UsageByModel,
} from "./types.js";

export interface ParsedResult {
  isError: boolean;
  subtype: string | null;
  terminalReason: string | null;
  stopReason: string | null;
  sessionId: string | null;
  resultText: string | null;
  /** The `errors` array joined, when the result carries one (a budget stop has no `result` text, verified 2026-10-14). */
  errorText: string | null;
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  /** Run totals: the sum of `usageByModel` when the result has `modelUsage`, else its `usage`. */
  usage: TokenUsage;
  usageByModel: UsageByModel | null;
  permissionDenials: number;
  deniedTools: DeniedTool[];
  /** The single model in `modelUsage`, `"mixed"` when there are several, null without it. */
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
  /** Agent tool calls seen in any session, by tool_use id: what was delegated, from the call's input. */
  agentCalls: Map<string, AgentCallInput>;
  /** Agent call tool_use id → agent id of the subagent it spawned (O(1) lookup on every tool_result). */
  subagentByParent: Map<string, string>;
  /**
   * Subagents whose durationMs is a measurement: a harness total (`totalDurationMs`,
   * `task_notification.usage.duration_ms`) or the gap between two stream timestamps. Any other
   * duration was derived from wall-clock time, which is meaningless during a log replay.
   */
  measured: Set<string>;
  /** Subagents whose hand-back was a background launch (`async_launched`): their task_notification closes them. */
  background: Set<string>;
  /** Subagents whose endedAt is the wall clock at parse time (the closing line had no timestamp). */
  wallClockEnd: Set<string>;
}

interface AgentCallInput {
  subagentType: string | null;
  description: string | null;
  prompt: string | null;
  /** Stream timestamp of the line that issued the call: the subagent's start when no nested line is seen. */
  at: string | null;
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
    agentCalls: new Map(),
    subagentByParent: new Map(),
    measured: new Set(),
    background: new Set(),
    wallClockEnd: new Set(),
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
          const outcome = status === null ? null : terminalStatus(status);
          // A failed outcome wins over an earlier completed; nothing downgrades failed.
          if (outcome === "failed" || (outcome === "completed" && record.status === "running")) record.status = outcome;
          const usage = isObject(msg["usage"]) ? msg["usage"] : {};
          const duration = num(usage["duration_ms"]);
          if (duration !== null) {
            record.durationMs = duration;
            state.measured.add(record.agentId);
          }
          record.totalTokens = num(usage["total_tokens"]) ?? record.totalTokens;
          if (record.resultText === null) {
            const summary = str(msg["summary"]);
            record.resultText = summary === null ? null : cleanHandBack(summary);
          }
          // A background subagent's hand-back was only the launch notice: this line is its end.
          if (outcome !== null && state.background.has(record.agentId) && record.endedAt === null) {
            closeSubagent(state, record, str(msg["timestamp"]), null, null);
            events.push({ type: "subagent_end", subagent: record });
          }
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
          // The Agent call's input is the authoritative brief: subagent_type, description, prompt.
          if (id && (name === "Agent" || name === "Task") && isObject(block["input"])) {
            const input = block["input"];
            const call = {
              subagentType: str(input["subagent_type"]),
              description: str(input["description"]),
              prompt: str(input["prompt"]),
              at: str(msg["timestamp"]),
            };
            state.agentCalls.set(id, call);
            const existing = subagentByParent(state, id);
            if (existing) fillFromAgentCall(existing, call);
          }
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
          if (!toolUseId) continue;
          const handBack = isObject(msg["tool_use_result"]) ? msg["tool_use_result"] : null;
          let record = subagentByParent(state, toolUseId);
          // No task_started and no nested lines (older CLI, or a stream without them): the
          // hand-back alone still identifies the subagent through tool_use_result.agentId.
          const handBackAgentId = handBack ? str(handBack["agentId"]) : null;
          if (
            !record &&
            handBackAgentId &&
            (state.agentCalls.has(toolUseId) || handBack?.["agentType"] !== undefined)
          ) {
            record = subagentFor(state, handBackAgentId, toolUseId, handBack?.["agentType"], null, events);
          }
          if (!record || record.endedAt !== null) continue;
          fillFromAgentCall(record, state.agentCalls.get(toolUseId));
          if (handBack) fillFromHandBack(state, record, handBack);
          // No tool_use_result (older CLIs): the tool_result itself is the end, as before.
          const outcome = handBack ? terminalStatus(str(handBack["status"])) : "completed";
          if (outcome === null) {
            // Background launch (async_launched): the text is the launch notice, not the report,
            // and the subagent is still working. Its task_notification closes it.
            state.background.add(record.agentId);
            continue;
          }
          const text = toolResultText(block["content"]);
          if (text) record.resultText = cleanHandBack(text);
          // A failed hand-back wins even over a completed task_notification; nothing downgrades failed.
          if (outcome === "failed" || record.status === "running") record.status = outcome;
          const total = handBack ? num(handBack["totalDurationMs"]) : null;
          closeSubagent(state, record, str(msg["timestamp"]), total, state.agentCalls.get(toolUseId)?.at ?? null);
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
  if (parent) {
    fillFromAgentCall(record, state.agentCalls.get(parent));
    if (!state.subagentByParent.has(parent)) state.subagentByParent.set(parent, agentId);
  }
  state.subagents.set(agentId, record);
  events.push({ type: "subagent_start", subagent: record });
  return record;
}

function subagentByParent(state: StreamState, parentToolUseId: string): SubagentRecord | undefined {
  const agentId = state.subagentByParent.get(parentToolUseId);
  return agentId === undefined ? undefined : state.subagents.get(agentId);
}

function fillFromAgentCall(record: SubagentRecord, call: AgentCallInput | undefined): void {
  if (!call) return;
  if (record.subagentType === "unknown" && call.subagentType) record.subagentType = call.subagentType;
  if (record.description === null) record.description = call.description;
  if (record.prompt === null) record.prompt = call.prompt;
}

/**
 * The hand-back line's `tool_use_result` (verified 2026-10-14, CLI 2.1.299): agentType,
 * prompt, resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, status. Exact
 * figures from the harness; they win over what was counted from forwarded lines, which
 * misses lines the CLI does not forward.
 */
function fillFromHandBack(state: StreamState, record: SubagentRecord, r: Json): void {
  const type = str(r["agentType"]);
  if (type && record.subagentType === "unknown") record.subagentType = type;
  if (record.prompt === null) record.prompt = str(r["prompt"]);
  if (record.model === null) record.model = str(r["resolvedModel"]);
  const total = num(r["totalDurationMs"]);
  if (total !== null) {
    record.durationMs = total;
    state.measured.add(record.agentId);
  }
  record.totalTokens = num(r["totalTokens"]) ?? record.totalTokens;
  const toolUses = num(r["totalToolUseCount"]);
  if (toolUses !== null) record.toolCalls = Math.max(record.toolCalls, toolUses);
}

/**
 * The outcome a hand-back or task_notification status reports, or null when the subagent is
 * still working (`async_launched` for a background Agent call, or any status not known to be
 * final). A hand-back without a status (older CLIs) is final: callers pass "completed" for it.
 */
function terminalStatus(status: string | null): "completed" | "failed" | null {
  if (status === null || status === "completed" || status === "success") return "completed";
  if (status === "failed" || status === "error" || status === "killed") return "failed";
  return null;
}

/**
 * Sets endedAt (stream time, else wall clock) and, when nothing measured it, the duration. A
 * subagent no nested line stamped (hand-back alone) still has the parse time as startedAt, i.e.
 * its end or the time of a replay: it is derived from the harness total or the Agent call time.
 */
function closeSubagent(
  state: StreamState,
  record: SubagentRecord,
  endTs: string | null,
  totalDurationMs: number | null,
  callAt: string | null,
): void {
  record.endedAt = endTs ?? new Date().toISOString();
  if (endTs === null) state.wallClockEnd.add(record.agentId);
  if (!state.stamped.has(record.agentId)) {
    const endMs = Date.parse(record.endedAt);
    if (totalDurationMs !== null && Number.isFinite(endMs)) {
      record.startedAt = new Date(endMs - totalDurationMs).toISOString();
      state.stamped.add(record.agentId);
    } else if (callAt) {
      record.startedAt = callAt;
      state.stamped.add(record.agentId);
    }
  }
  if (record.durationMs !== null) return;
  record.durationMs = Math.max(0, Date.parse(record.endedAt) - Date.parse(record.startedAt));
  // Two stream timestamps make a measurement; wall-clock time (a replay's clock) does not.
  if (endTs !== null && state.stamped.has(record.agentId)) state.measured.add(record.agentId);
}

const HAND_BACK_PREAMBLE = /^\[Subagent hand-back\][\s\S]*?The report follows:\s*\n/;
/** Footer after a preamble: an optional `agentId:` line, then the `<usage>` block. */
const HAND_BACK_FOOTER = /\n(?:agentId: [^\n]*\n)?<usage>[\s\S]*?<\/usage>\s*$/;
/**
 * Footer without a preamble: only with its `agentId:` line, so a report that itself ends with a
 * literal `<usage>` block is left whole.
 */
const HAND_BACK_FOOTER_WITH_ID = /\nagentId: [^\n]*\n<usage>[\s\S]*?<\/usage>\s*$/;

/** The text still carries Claude Code's hand-back frame (preamble, or the agentId footer). Two regex tests, no rewrite. */
export function isRawHandBack(text: string): boolean {
  return HAND_BACK_PREAMBLE.test(text) || HAND_BACK_FOOTER_WITH_ID.test(text);
}

/**
 * The report as the subagent wrote it. Claude Code wraps it in a hand-back frame (a
 * provenance preamble, every line indented by two spaces, an `agentId:` / `<usage>`
 * footer); stored raw, the first 300 characters were all frame and no report.
 */
export function cleanHandBack(text: string): string {
  const m = HAND_BACK_PREAMBLE.exec(text);
  if (!m) return HAND_BACK_FOOTER_WITH_ID.test(text) ? text.replace(HAND_BACK_FOOTER_WITH_ID, "").trimEnd() : text;
  const body = text.slice(m[0].length).replace(HAND_BACK_FOOTER, "");
  return body
    .split("\n")
    .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
    .join("\n")
    .trim();
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

  const usageByModel = parseModelUsage(msg["modelUsage"]);
  const models = usageByModel ? Object.keys(usageByModel) : [];
  const modelUsed = models.length === 0 ? null : models.length === 1 ? models[0]! : MIXED_MODEL;

  return {
    isError: msg["is_error"] === true,
    subtype: str(msg["subtype"]),
    terminalReason: str(msg["terminal_reason"]),
    stopReason: str(msg["stop_reason"]),
    sessionId: str(msg["session_id"]),
    resultText: str(msg["result"]),
    errorText:
      Array.isArray(msg["errors"]) && msg["errors"].length
        ? msg["errors"].filter((e): e is string => typeof e === "string").join("; ") || null
        : null,
    numTurns: num(msg["num_turns"]),
    durationMs: num(msg["duration_ms"]),
    costUsd: num(msg["total_cost_usd"]),
    // `usage` counts the main session only; `modelUsage` covers subagents too (verified
    // 2026-10-20 on a logged run: main 6153 output tokens, modelUsage 10485 + 4774).
    usage: usageByModel
      ? sumUsage(Object.values(usageByModel))
      : {
          inputTokens: num(usage["input_tokens"]),
          outputTokens: num(usage["output_tokens"]),
          cacheReadTokens: num(usage["cache_read_input_tokens"]),
          cacheCreationTokens: num(usage["cache_creation_input_tokens"]),
        },
    usageByModel,
    permissionDenials: denials,
    deniedTools,
    modelUsed,
    raw: msg,
  };
}

/**
 * The result line's `modelUsage`: `{ "<model id>": { inputTokens, outputTokens,
 * cacheReadInputTokens, cacheCreationInputTokens, costUSD, ... } }` (Claude Code 2.1.3xx).
 * Null when absent, not an object, or without one usable entry.
 */
function parseModelUsage(v: unknown): UsageByModel | null {
  if (!isObject(v)) return null;
  const out: UsageByModel = {};
  for (const [model, u] of Object.entries(v)) {
    if (!isObject(u)) continue;
    out[model] = {
      inputTokens: num(u["inputTokens"]),
      outputTokens: num(u["outputTokens"]),
      cacheReadTokens: num(u["cacheReadInputTokens"]),
      cacheCreationTokens: num(u["cacheCreationInputTokens"]),
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Field-wise sum; a field stays null only when it is null in every entry. */
export function sumUsage(entries: TokenUsage[]): TokenUsage {
  const total = emptyUsage();
  for (const u of entries) {
    for (const key of Object.keys(total) as Array<keyof TokenUsage>) {
      const v = u[key];
      if (v !== null) total[key] = (total[key] ?? 0) + v;
    }
  }
  return total;
}

/** Per-model usage of two processes (main pass + wrap-up) as one map; null when both are null. */
export function mergeUsageByModel(a: UsageByModel | null, b: UsageByModel | null): UsageByModel | null {
  if (!a) return b;
  if (!b) return a;
  const out: UsageByModel = { ...a };
  for (const [model, u] of Object.entries(b)) out[model] = out[model] ? sumUsage([out[model], u]) : u;
  return out;
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
