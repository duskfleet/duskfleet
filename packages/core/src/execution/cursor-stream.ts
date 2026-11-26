/**
 * Parser of Cursor Agent CLI's `cursor-agent -p --output-format stream-json` stream (issue #467),
 * written against the fixtures in `packages/mcp/test/fixtures/cursor/` (their README lists what
 * every run shows). One JSON object per line: `system` / `init` (`session_id`, `model`: a display
 * name), `user`, many `thinking` lines (no state), `assistant` lines (one complete message each),
 * `tool_call` pairs (`started` then `completed`, same `call_id`) and, for a run that ended on its
 * own, one `result` line (`is_error`, `usage` in tokens, no cost, no turn count).
 *
 * A refused tool call is a denial: `result.rejected` (a shell command or MCP call no rule allows),
 * `result.writePermissionDenied` (a `Write(...)` deny), `result.permissionDenied` (a deny rule, MCP).
 * `result.result` joins every assistant message with no separator, so the final text is the last
 * `assistant` line, never that field.
 *
 * Unknown line and tool types are ignored, never a `parse_error`: that is kept for a line that is
 * not a JSON object at all.
 */
import type { DeniedTool, ExecutionEvent, SubagentRecord, TokenUsage } from "./types.js";

export interface CursorStreamState {
  /** `system/init`'s `session_id`: the id `--resume` takes. */
  sessionId: string | null;
  /** `init`'s `model` (a display name such as "Auto"). */
  model: string | null;
  lastAssistantText: string | null;
  /** Tool calls the model made, one per `call_id`. */
  toolCalls: number;
  usage: TokenUsage;
  permissionDenials: number;
  deniedTools: DeniedTool[];
  /** The `result` line, when one arrived. */
  result: Record<string, unknown> | null;
  /** Lines read that were JSON objects. */
  lines: number;
  /** `call_id`s already counted. */
  seenCalls: Set<string>;
  /** Open `taskToolCall`s by `call_id`. */
  openSubagents: Map<string, SubagentRecord>;
  subagents: SubagentRecord[];
}

export function createCursorState(): CursorStreamState {
  return {
    sessionId: null,
    model: null,
    lastAssistantText: null,
    toolCalls: 0,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
    permissionDenials: 0,
    deniedTools: [],
    result: null,
    lines: 0,
    seenCalls: new Set(),
    openSubagents: new Map(),
    subagents: [],
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Some durations arrive as strings (`taskToolCall.result.success.durationMs: "2498"`).
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
};
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The result kinds that mean the CLI refused the call (fixtures `shell-denied`, `write-denied`, `mcp-*`). */
const DENIAL_KINDS = ["rejected", "writePermissionDenied", "permissionDenied"] as const;

/** Tokens of a `result.usage` (`cacheWriteTokens` is the cache creation figure). */
export function cursorUsage(usage: unknown): TokenUsage {
  const u = obj(usage) ?? {};
  return {
    inputTokens: num(u["inputTokens"]),
    outputTokens: num(u["outputTokens"]),
    cacheReadTokens: num(u["cacheReadTokens"]),
    cacheCreationTokens: num(u["cacheWriteTokens"]),
  };
}

/** The tool's key (`shellToolCall`, `editToolCall`, ...) and its body. */
function toolOf(line: Record<string, unknown>): { name: string; body: Record<string, unknown> } | null {
  const call = obj(line["tool_call"]);
  if (!call) return null;
  for (const [name, value] of Object.entries(call)) {
    const body = obj(value);
    if (body) return { name, body };
  }
  return null;
}

/** What a call did, shortened, for the timeline and the denied-tool list. */
function summaryOf(name: string, args: Record<string, unknown>): string | null {
  const s =
    name === "shellToolCall"
      ? str(args["command"])
      : name === "editToolCall"
        ? str(args["path"])
        : name === "mcpToolCall"
          ? str(args["name"])
          : name === "taskToolCall"
            ? str(args["description"])
            : null;
  return s === null ? null : s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

function inputOf(name: string, args: Record<string, unknown>): unknown {
  if (name === "shellToolCall") return { command: str(args["command"]) ?? "" };
  if (name === "editToolCall") return { path: str(args["path"]) };
  if (name === "mcpToolCall")
    return { server: str(args["providerIdentifier"]), tool: str(args["toolName"]), args: args["args"] ?? null };
  if (name === "taskToolCall") return { description: str(args["description"]), prompt: str(args["prompt"]) };
  return args;
}

function subagentType(args: Record<string, unknown>): string {
  const t = args["subagentType"];
  if (typeof t === "string") return t;
  const custom = obj(obj(t)?.["custom"]);
  return str(custom?.["name"]) ?? "task";
}

function lastStepText(success: Record<string, unknown>): string | null {
  const steps = Array.isArray(success["conversationSteps"]) ? success["conversationSteps"] : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const text = str(obj(obj(steps[i])?.["assistantMessage"])?.["text"]);
    if (text) return text;
  }
  return null;
}

/** Events for one stdout line; mutates `state`. */
export function ingestCursorLine(state: CursorStreamState, line: string): ExecutionEvent[] {
  if (!line.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: "parse_error", line: line.slice(0, 2000) }];
  }
  const ev = obj(parsed);
  if (!ev) return [{ type: "parse_error", line: line.slice(0, 2000) }];
  state.lines += 1;
  const out: ExecutionEvent[] = [];

  switch (str(ev["type"])) {
    case "system": {
      if (str(ev["subtype"]) !== "init") break;
      state.sessionId = str(ev["session_id"]) ?? state.sessionId;
      state.model = str(ev["model"]) ?? state.model;
      out.push({
        type: "init",
        sessionId: state.sessionId ?? "",
        model: state.model,
        tools: [],
        mcpServers: [],
        cliVersion: null,
      });
      break;
    }
    case "assistant": {
      const content = obj(ev["message"])?.["content"];
      const parts = Array.isArray(content) ? content : [];
      const text = parts.map((p) => (str(obj(p)?.["type"]) === "text" ? (str(obj(p)?.["text"]) ?? "") : "")).join("");
      if (text.trim()) {
        state.lastAssistantText = text;
        out.push({ type: "assistant_text", text, agentId: null });
      }
      break;
    }
    case "tool_call": {
      const tool = toolOf(ev);
      const callId = str(ev["call_id"]);
      if (!tool) break;
      const args = obj(tool.body["args"]) ?? {};
      const completed = str(ev["subtype"]) === "completed";
      if (!callId || !state.seenCalls.has(callId)) {
        if (callId) state.seenCalls.add(callId);
        state.toolCalls += 1;
        out.push({ type: "tool_use", name: tool.name, id: callId, input: inputOf(tool.name, args), agentId: null });
        if (tool.name === "taskToolCall" && callId) {
          const record: SubagentRecord = {
            agentId: str(args["agentId"]) ?? callId,
            parentToolUseId: callId,
            parentAgentId: null,
            subagentType: subagentType(args),
            description: str(args["description"]),
            prompt: str(args["prompt"]),
            resultText: null,
            status: "running",
            model: null,
            startedAt: new Date().toISOString(),
            endedAt: null,
            durationMs: null,
            toolCalls: 0,
            tools: [],
            usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
            totalTokens: null,
          };
          state.openSubagents.set(callId, record);
          state.subagents.push(record);
          out.push({ type: "subagent_start", subagent: { ...record } });
        }
      }
      if (!completed) break;
      const result = obj(tool.body["result"]) ?? {};
      const denial = DENIAL_KINDS.find((k) => obj(result[k]) !== null);
      if (denial) {
        state.permissionDenials += 1;
        state.deniedTools.push({ tool: tool.name, summary: summaryOf(tool.name, args) });
      }
      if (tool.name === "shellToolCall" && callId) {
        const success = obj(result["success"]);
        const failure = obj(result["failure"]);
        const done = success ?? failure;
        const stdout = str(done?.["stdout"]);
        const stderr = str(done?.["stderr"]);
        const output = [stdout, stderr].filter((s) => s).join("\n") || null;
        out.push({
          type: "bash_result",
          toolUseId: callId,
          command: str(args["command"]) ?? "",
          output,
          isError: !success || (num(success["exitCode"]) ?? 0) !== 0,
          agentId: null,
        });
      }
      if (tool.name === "taskToolCall" && callId) {
        const record = state.openSubagents.get(callId);
        if (record) {
          state.openSubagents.delete(callId);
          const success = obj(result["success"]);
          record.status = success ? "completed" : "failed";
          record.resultText = success ? lastStepText(success) : null;
          record.endedAt = new Date().toISOString();
          record.durationMs = success ? num(success["durationMs"]) : null;
          out.push({ type: "subagent_end", subagent: { ...record } });
        }
      }
      break;
    }
    case "result": {
      state.result = ev;
      state.usage = cursorUsage(ev["usage"]);
      state.sessionId = str(ev["session_id"]) ?? state.sessionId;
      break;
    }
    default:
      break;
  }
  return out;
}
