/**
 * Parser of GitHub Copilot CLI's `--output-format json` stream (issue #446), written against the
 * fixtures in `packages/mcp/test/fixtures/copilot/` (Copilot CLI 1.0.112, their README lists what
 * every run shows). One JSON object per line, `{type, data, id, timestamp, parentId}`, except the
 * last one: `{type: "result", sessionId, exitCode, usage}` without a `data` wrapper.
 *
 * Unknown event types are ignored (the CLI prints many status lines), never a `parse_error`: that
 * is kept for a line that is not JSON at all.
 */
import type { DeniedTool, ExecutionEvent, McpServerInfo, TokenUsage, UsageByModel } from "./types.js";

/** The closing `result` line. */
export interface CopilotResultLine {
  sessionId: string | null;
  exitCode: number | null;
  /** `premiumRequests`, durations, `codeChanges`; cumulative for the session on a resumed run. */
  usage: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface CopilotStreamState {
  sessionId: string | null;
  model: string | null;
  cliVersion: string | null;
  /** `session.start` or `session.resume` was seen. */
  started: boolean;
  /** The `init` event went out (at `session.mcp_servers_loaded`, or before the first later event). */
  initEmitted: boolean;
  mcpServers: McpServerInfo[];
  lastAssistantText: string | null;
  toolCalls: number;
  permissionDenials: number;
  deniedTools: DeniedTool[];
  /** `session.error`: why the session failed (`errorType`, `message`). */
  error: { type: string | null; message: string } | null;
  /** `session.info` with `infoType: "cancellation"` (SIGTERM). */
  cancelled: boolean;
  result: CopilotResultLine | null;
  /** Lines read that were JSON objects. */
  lines: number;
  /** Tool calls by id: name and arguments, for the denial summary and the shell result. */
  calls: Map<string, { name: string; args: unknown }>;
}

export function createCopilotState(): CopilotStreamState {
  return {
    sessionId: null,
    model: null,
    cliVersion: null,
    started: false,
    initEmitted: false,
    mcpServers: [],
    lastAssistantText: null,
    toolCalls: 0,
    permissionDenials: 0,
    deniedTools: [],
    error: null,
    cancelled: false,
    result: null,
    lines: 0,
    calls: new Map(),
  };
}

/** The shell tool's name in the stream (`bash`; `powershell` on Windows). */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Command / path / first string argument of a tool call, shortened. */
export function copilotToolSummary(args: unknown, max = 120): string | null {
  const a = obj(args);
  if (!a) return null;
  const text =
    str(a["command"]) ?? str(a["path"]) ?? (Object.values(a).find((v) => typeof v === "string") as string | undefined);
  if (!text?.trim()) return null;
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Events for one stdout line; mutates `state`. */
export function ingestCopilotLine(state: CopilotStreamState, line: string): ExecutionEvent[] {
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
  const type = str(ev["type"]);
  const data = obj(ev["data"]) ?? {};
  const out: ExecutionEvent[] = [];
  const init = () => {
    if (state.initEmitted || !state.started) return;
    state.initEmitted = true;
    out.push({
      type: "init",
      sessionId: state.sessionId ?? "",
      model: state.model,
      tools: [],
      mcpServers: state.mcpServers,
      cliVersion: state.cliVersion,
    });
  };

  switch (type) {
    case "session.start":
      state.started = true;
      state.sessionId = str(data["sessionId"]) ?? state.sessionId;
      state.model = str(data["selectedModel"]) ?? state.model;
      state.cliVersion = str(data["copilotVersion"]) ?? state.cliVersion;
      break;
    case "session.resume":
      // No session id and no CLI version on this line: the caller's id stands.
      state.started = true;
      state.model = str(data["selectedModel"]) ?? state.model;
      break;
    case "session.model_change":
      // A link whose agent file names a model and no --model (fixture link-model, 1.0.114):
      // session.start has no selectedModel, then a `startup` (account default) and an `agent` change.
      state.model = str(data["newModel"]) ?? state.model;
      break;
    case "session.mcp_servers_loaded": {
      const servers = Array.isArray(data["servers"]) ? data["servers"] : [];
      state.mcpServers = servers
        .map((s) => obj(s))
        .filter((s): s is Record<string, unknown> => s !== null && typeof s["name"] === "string")
        .map((s) => ({ name: s["name"] as string, status: str(s["status"]) ?? "unknown" }));
      init();
      break;
    }
    case "assistant.message": {
      init();
      state.model = str(data["model"]) ?? state.model;
      const text = str(data["content"]);
      if (text?.trim()) {
        state.lastAssistantText = text;
        out.push({ type: "assistant_text", text, agentId: null });
      }
      break;
    }
    case "tool.execution_start": {
      init();
      const id = str(data["toolCallId"]);
      const name = str(data["toolName"]) ?? "unknown";
      state.toolCalls += 1;
      if (id) state.calls.set(id, { name, args: data["arguments"] });
      out.push({ type: "tool_use", name, id, input: data["arguments"], agentId: null });
      break;
    }
    case "tool.execution_complete": {
      init();
      const id = str(data["toolCallId"]);
      const call = id ? state.calls.get(id) : undefined;
      const success = data["success"] === true;
      const error = obj(data["error"]);
      if (!success && str(error?.["code"]) === "denied") {
        state.permissionDenials += 1;
        state.deniedTools.push({ tool: call?.name ?? "unknown", summary: copilotToolSummary(call?.args) });
      }
      if (id && call && SHELL_TOOLS.has(call.name)) {
        out.push({
          type: "bash_result",
          toolUseId: id,
          command: str(obj(call.args)?.["command"]) ?? "",
          output: str(obj(data["result"])?.["content"]),
          isError: !success,
          agentId: null,
        });
      }
      break;
    }
    case "session.error":
      init();
      state.error = { type: str(data["errorType"]), message: str(data["message"]) ?? "session error" };
      break;
    case "session.info":
      if (str(data["infoType"]) === "cancellation") state.cancelled = true;
      break;
    case "result": {
      init();
      const exitCode = typeof ev["exitCode"] === "number" ? (ev["exitCode"] as number) : null;
      state.sessionId = str(ev["sessionId"]) ?? state.sessionId;
      state.result = { sessionId: str(ev["sessionId"]), exitCode, usage: obj(ev["usage"]), raw: ev };
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Tokens per model from the file `--usage-output-file` writes (`modelMetrics.<model>.usage`), or
 * null when it has none. Cumulative for the session, like `result.usage`.
 */
export function copilotUsageByModel(usageFile: unknown): UsageByModel | null {
  const metrics = obj(obj(usageFile)?.["modelMetrics"]);
  if (!metrics) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const byModel: UsageByModel = {};
  for (const [model, m] of Object.entries(metrics)) {
    const u = obj(obj(m)?.["usage"]);
    if (!u) continue;
    byModel[model] = {
      inputTokens: num(u["inputTokens"]),
      outputTokens: num(u["outputTokens"]),
      cacheReadTokens: num(u["cacheReadTokens"]),
      cacheCreationTokens: num(u["cacheWriteTokens"]),
    };
  }
  return Object.keys(byModel).length ? byModel : null;
}

/** The sum of `usageByModel`, null fields when nothing reported them. */
export function sumUsage(byModel: UsageByModel | null): TokenUsage {
  const total: TokenUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
  for (const u of Object.values(byModel ?? {})) {
    for (const k of Object.keys(total) as (keyof TokenUsage)[]) {
      const v = u[k];
      if (v !== null) total[k] = (total[k] ?? 0) + v;
    }
  }
  return total;
}

/**
 * `--resume=<id>` named a session Copilot does not have: nothing on stdout, and a stderr line
 * starts with `Error: No session, task, or name matched` (fixture `resume-unknown`). Matched per
 * line, so a banner or warning printed before it does not hide it.
 */
export function isCopilotSessionNotFound(stdoutLines: number, stderr: string): boolean {
  return stdoutLines === 0 && /^[ \t]*Error: No session, task, or name matched\b/m.test(stderr);
}
