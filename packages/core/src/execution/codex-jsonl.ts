/**
 * Parser of Codex CLI's `codex exec --json` stream (issue #50), written against the fixtures in
 * `packages/mcp/test/fixtures/codex/` (codex-cli 0.167.1, their README lists what every run shows).
 * One JSON object per line: `thread.started` (`thread_id`, the session id), `turn.started`,
 * `item.started` / `item.completed` pairs, then one terminal event, `turn.completed` (`usage`) or
 * `turn.failed` (`error.message`). The stream names no model and reports no cost.
 *
 * Unknown event and item types are ignored, never a `parse_error`: that is kept for a line that is
 * not a JSON object at all.
 */
import type { ExecutionEvent, TokenUsage } from "./types.js";

/** The terminal event of a turn. */
export interface CodexTurnEnd {
  kind: "completed" | "failed";
  /** `turn.failed`'s `error.message`; null for a completed turn. */
  error: string | null;
  raw: Record<string, unknown>;
}

export interface CodexStreamState {
  /** `thread.started`'s `thread_id`: the id `codex exec resume` takes. */
  threadId: string | null;
  lastAssistantText: string | null;
  /** `command_execution` and `file_change` items. */
  toolCalls: number;
  /** Summed over the `turn.completed` lines; `inputTokens` excludes the cached ones. */
  usage: TokenUsage;
  /** The last top-level `error` event's message (an unknown model, ...), kept for the failure text. */
  lastError: string | null;
  turnEnd: CodexTurnEnd | null;
  /** Lines read that were JSON objects. */
  lines: number;
  /** Item ids already counted as a tool call (an item comes as `item.started` then `item.completed`). */
  seenItems: Set<string>;
}

export function createCodexState(): CodexStreamState {
  return {
    threadId: null,
    lastAssistantText: null,
    toolCalls: 0,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
    lastError: null,
    turnEnd: null,
    lines: 0,
    seenItems: new Set(),
  };
}

/** Item types that are tool calls of the agent (fixtures `shell`, `codex-home-patch`). */
const TOOL_ITEMS = new Set(["command_execution", "file_change"]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function add(total: number | null, v: number | null): number | null {
  return v === null ? total : (total ?? 0) + v;
}

/**
 * Tokens of one `turn.completed.usage`. Codex's `input_tokens` includes `cached_input_tokens`
 * (fixtures README), while `inputTokens` here, as for Claude, is the uncached part only.
 */
export function codexTurnUsage(usage: unknown): TokenUsage {
  const u = obj(usage) ?? {};
  const input = num(u["input_tokens"]);
  const cached = num(u["cached_input_tokens"]);
  return {
    inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
    outputTokens: num(u["output_tokens"]),
    cacheReadTokens: cached,
    cacheCreationTokens: num(u["cache_write_input_tokens"]),
  };
}

/** Events for one stdout line; mutates `state`. */
export function ingestCodexLine(state: CodexStreamState, line: string): ExecutionEvent[] {
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
    case "thread.started": {
      state.threadId = str(ev["thread_id"]) ?? state.threadId;
      // No model, no CLI version and no MCP list in this stream: the init carries the session only.
      out.push({
        type: "init",
        sessionId: state.threadId ?? "",
        model: null,
        tools: [],
        mcpServers: [],
        cliVersion: null,
      });
      break;
    }
    case "item.started":
    case "item.completed": {
      const item = obj(ev["item"]);
      if (!item) break;
      const id = str(item["id"]);
      const itemType = str(item["type"]);
      const completed = ev["type"] === "item.completed";
      if (itemType === "agent_message" && completed) {
        const text = str(item["text"]);
        if (text?.trim()) {
          state.lastAssistantText = text;
          out.push({ type: "assistant_text", text, agentId: null });
        }
        break;
      }
      if (!itemType || !TOOL_ITEMS.has(itemType)) break;
      // One tool call per item id: a completed item whose start was not seen still counts.
      if (!id || !state.seenItems.has(id)) {
        if (id) state.seenItems.add(id);
        state.toolCalls += 1;
        out.push({ type: "tool_use", name: itemType, id, input: toolInput(item), agentId: null });
      }
      if (completed && itemType === "command_execution" && id) {
        // A failed command (the sandbox refused a write, a blocked host) is the command's own
        // failure: nothing in the stream says the sandbox was the cause, so nothing guesses it.
        out.push({
          type: "bash_result",
          toolUseId: id,
          command: str(item["command"]) ?? "",
          output: str(item["aggregated_output"]),
          isError: str(item["status"]) === "failed",
          agentId: null,
        });
      }
      break;
    }
    case "error":
      state.lastError = str(ev["message"]) ?? state.lastError;
      break;
    case "turn.completed": {
      const u = codexTurnUsage(ev["usage"]);
      for (const k of Object.keys(u) as (keyof TokenUsage)[]) state.usage[k] = add(state.usage[k], u[k]);
      state.turnEnd = { kind: "completed", error: null, raw: ev };
      break;
    }
    case "turn.failed":
      state.turnEnd = {
        kind: "failed",
        error: str(obj(ev["error"])?.["message"]) ?? state.lastError ?? "turn failed",
        raw: ev,
      };
      break;
    default:
      break;
  }
  return out;
}

/** What a tool item did, for the timeline: the command, or the files a patch changed. */
function toolInput(item: Record<string, unknown>): unknown {
  if (str(item["type"]) === "command_execution") return { command: str(item["command"]) ?? "" };
  const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
  return {
    changes: changes
      .map((c) => obj(c))
      .filter((c): c is Record<string, unknown> => c !== null)
      .map((c) => ({ path: str(c["path"]), kind: str(c["kind"]) })),
  };
}
