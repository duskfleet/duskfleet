/**
 * Execution abstraction. This is the only contract the rest of Duskfleet
 * uses to run an agent. `ClaudeCodeExecutor` is the one implementation today.
 */
import type { EffortLevel, PermissionMode } from "../config/types.js";
import type { FailureClassification } from "../observability/failure.js";
import type { BillingType, RecordedCommand } from "../observability/run.js";

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
  /**
   * Server prefixes (`mcp__claude_ai_Figma`) the run needs. When the child's `init` line reports
   * no server of a prefix, the process is ended and started again, once: Claude Code sometimes
   * comes up without any claude.ai connector (3 runs out of 12 on 2026-10-20), and `init` is
   * printed before the first model turn, so the restart costs seconds, not dollars.
   */
  requiredMcpServers?: string[];
  /** Passed as --add-dir. */
  addDirs?: string[];
  /** Passed as --agent: adopt a project-defined Claude Code agent. */
  claudeAgent?: string;
  /**
   * Variables (exact names or `PREFIX_*`) passed to the child on top of the default allow-list
   * (`DEFAULT_ENV_ALLOW` in child-env.ts). Everything else in our environment is dropped.
   */
  envPassthrough?: string[];
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
  | {
      type: "init";
      sessionId: string;
      model: string | null;
      tools: string[];
      mcpServers: McpServerInfo[];
      cliVersion: string | null;
    }
  | { type: "tool_use"; name: string; id: string | null; input?: unknown; agentId: string | null }
  | { type: "assistant_text"; text: string; agentId: string | null }
  | { type: "subagent_start"; subagent: SubagentRecord }
  | { type: "subagent_end"; subagent: SubagentRecord }
  | { type: "stderr"; text: string }
  /**
   * The process (or a descendant holding its stdio, such as a user-level Stop hook) was still
   * running `afterMs` after the result line, so its process group was sent SIGTERM (SIGKILL
   * after the kill grace). `childAlive` is false when only descendants were left.
   */
  | { type: "grace_kill"; pid: number | null; afterMs: number; childAlive: boolean }
  /**
   * The first process reported `init` without a required MCP server (`missing`, prefixes;
   * `mounted`, the names it did report) and was replaced by a fresh one (`pid`, `sessionId`).
   * At most once per run; the second process is kept whatever its init says.
   */
  | { type: "mcp_restart"; missing: string[]; mounted: string[]; pid: number | null; sessionId: string }
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

/** Token usage keyed by model id, as the result line's `modelUsage` reports it. */
export type UsageByModel = Record<string, TokenUsage>;

/** `modelUsed` of a run whose tokens were spent on more than one model (subagents). */
export const MIXED_MODEL = "mixed";

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
  /** Run totals: the sum of `usageByModel` when known, else the result line's `usage`. */
  usage: TokenUsage;
  /** Per model, from the result line's `modelUsage`; null when it had none. */
  usageByModel: UsageByModel | null;
  costUsd: number | null;
  permissionDenials: number;
  deniedTools: DeniedTool[];
  /** Heuristic: the run stopped because the context window was exhausted. */
  contextExhausted: boolean;
  /** Why the run failed, as a code (`classifyFailure`); null when unknown or when it did not fail. */
  failure: FailureClassification | null;
  /** Full raw result object from the tool, for later analysis. */
  rawResult: unknown;
  /** Subagent invocations observed in the stream, in start order. */
  subagents: SubagentRecord[];
}

export interface ExecutionHandle {
  command: RecordedCommand;
  pid: number | null;
  /** From the environment the child was spawned with; executors that cannot tell leave it out. */
  billingType?: BillingType;
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
