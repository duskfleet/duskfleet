/**
 * Execution abstraction. This is the only contract the rest of DuskFleet
 * uses to run an agent. `ClaudeCodeExecutor` is the one implementation today.
 */
import type { EffortLevel, PermissionMode } from "../config/types.js";
import type { RecordedCommand } from "../observability/run.js";

export interface ExecutionRequest {
  /** Working directory for the child process. Must already be validated. */
  cwd: string;
  prompt: string;
  /** Session id chosen by the caller so it is known before the process starts. */
  sessionId: string;
  /**
   * Continue an existing session (`claude --resume <id>`) instead of starting one with
   * `--session-id`. Used by the wrap-up pass after a budget exhaustion. The log file is
   * appended, not replaced.
   */
  resumeSessionId?: string;
  permissionMode: PermissionMode;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  effort?: EffortLevel;
  maxBudgetUsd?: number;
  /** Drop --strict-mcp-config so the run sees the user's MCP servers (claude.ai connectors, .mcp.json). */
  inheritMcp?: boolean;
  /** Passed as --add-dir. */
  addDirs?: string[];
  /** Passed as --agent: adopt a project-defined Claude Code agent. */
  claudeAgent?: string;
  timeoutMs?: number;
  /** Absolute path of the file that receives every raw event line. */
  logPath?: string;
}

/**
 * Structured events emitted while the process runs. `agentId` is null for the main
 * session and the Claude Code task id of the subagent that produced the message
 * otherwise (see SubagentRecord).
 */
export type ExecutionEvent =
  | { type: "init"; sessionId: string; model: string | null; tools: string[]; mcpServers: McpServerInfo[]; cliVersion: string | null }
  | { type: "tool_use"; name: string; id: string | null; input?: unknown; agentId: string | null }
  | { type: "assistant_text"; text: string; agentId: string | null }
  | { type: "subagent_start"; subagent: SubagentRecord }
  | { type: "subagent_end"; subagent: SubagentRecord }
  | { type: "stderr"; text: string }
  | { type: "parse_error"; line: string };

export type SubagentStatus = "running" | "completed" | "failed" | "interrupted";

/**
 * One subagent invocation inside a run: what the parent delegated (the Agent tool
 * call), what came back, and what the subagent did in between. Built from Claude
 * Code's `task_started` / `task_notification` system lines and from the `agent_id` /
 * `parent_tool_use_id` fields every nested message carries (verified 2026-10-12).
 */
export interface SubagentRecord {
  /** Claude Code task id; every message of this subagent carries it as `agent_id`. */
  agentId: string;
  /** Agent tool_use id in the parent that spawned it. */
  parentToolUseId: string | null;
  /** Subagent that issued the Agent call; null when it was the main session. */
  parentAgentId: string | null;
  /** The `subagent_type`: a project agent (`.claude/agents/<name>.md`) or a builtin such as `claude`. */
  subagentType: string;
  description: string | null;
  /** The brief the parent gave. */
  prompt: string | null;
  /** The subagent's final report as handed back to the parent. */
  resultText: string | null;
  status: SubagentStatus;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  toolCalls: number;
  /** Distinct tool names, in first-use order. */
  tools: string[];
  /**
   * Summed from the subagent's assistant lines. Cache figures are exact; `outputTokens`
   * is a streaming snapshot and undercounts. Prefer `totalTokens` for cost estimates.
   */
  usage: TokenUsage;
  /** Total tokens as reported by Claude Code's task_progress / task_notification lines. */
  totalTokens: number | null;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export type ExecutionOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export interface McpServerInfo {
  name: string;
  status: string;
}

/** MCP visibility for a run: what Claude Code reported mounted, which servers tools were actually called on,
 *  and allow-list entries that matched nothing mounted (likely a naming mismatch such as plugin_* vs claude_ai_*). */
export interface RunMcpInfo {
  mounted: McpServerInfo[];
  used: string[];
  allowListedMissing: string[];
}

/** One tool call the permission system refused. Unattended runs cannot prompt, so this means the allow-list is incomplete. */
export interface DeniedTool {
  tool: string;
  /** Command / file / first string argument, shortened. */
  summary: string | null;
}

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  sessionId: string;
  model: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  /** Termination reason as reported by the tool (e.g. Claude's terminal_reason / subtype). */
  terminationReason: string | null;
  error: string | null;
  resultText: string | null;
  numTurns: number | null;
  toolCalls: number;
  usage: TokenUsage;
  costUsd: number | null;
  permissionDenials: number;
  deniedTools: DeniedTool[];
  /** Heuristic: the run stopped because the context window was exhausted. */
  contextExhausted: boolean;
  /** Full raw result object from the tool, for later analysis. */
  rawResult: unknown;
  /** Subagent invocations observed in the stream, in start order. */
  subagents: SubagentRecord[];
}

export interface ExecutionHandle {
  command: RecordedCommand;
  pid: number | null;
  done: Promise<ExecutionResult>;
  cancel(): void;
}

export interface Executor {
  readonly name: string;
  /** Resolved binary path, for diagnostics and for recording in the Run. */
  readonly binary: string;
  version(): Promise<string>;
  execute(request: ExecutionRequest, onEvent?: (event: ExecutionEvent) => void): ExecutionHandle;
}
