/**
 * Declarative configuration types. Everything here is loaded from files under
 * `config/` and represents what DuskFleet *should* do.
 */

/** Permission modes accepted by `claude --permission-mode` (verified against CLI 2.1.285). */
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** `none`: a failed run is final. `resume_once`: the next tick of the schedule resumes the session, once. */
export const ON_FAILURE_POLICIES = ["none", "resume_once"] as const;
export type OnFailurePolicy = (typeof ON_FAILURE_POLICIES)[number];

/** Where an agent definition was loaded from. Only "user" agents are writable by tools. */
export type AgentSource = "builtin" | "user";

export interface AgentDefinition {
  id: string;
  /** builtin = config/agents (versioned); user = user_agents_dir (runtime, git-ignored). */
  source: AgentSource;
  name: string;
  description: string;
  /** Default model for this agent. Only sent to Claude when set (or overridden per run). */
  model?: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  effort?: EffortLevel;
  timeoutMinutes?: number;
  maxBudgetUsd?: number;
  /**
   * Dollars held back from `maxBudgetUsd` for a wrap-up pass: when the main pass ends
   * `budget_exhausted`, the session is resumed with this budget and told to record where it
   * stopped. Default 10% of the budget, at least $0.50, never more than half of it. 0 disables.
   */
  wrapUpReserveUsd?: number;
  /**
   * What a schedule does on the tick after a run of this agent ended `budget_exhausted` or
   * `timed_out`: `resume_once` resumes that session (one retry, a second failure is final)
   * instead of starting fresh. A schedule can override it. Default none.
   */
  onFailure?: OnFailurePolicy;
  /** Budget of the resumed run (`on_failure: resume_once`). Defaults to `maxBudgetUsd`. */
  resumeBudgetUsd?: number;
  /**
   * Let runs see the MCP servers of the user running DuskFleet (claude.ai
   * connectors such as Atlassian or Figma, user/project .mcp.json). Default
   * false: runs start with --strict-mcp-config and no MCP at all.
   * Tools still need an allowed_tools entry such as "mcp__claude_ai_Figma".
   */
  inheritMcp?: boolean;
  /** Extra directories the run may read/write (--add-dir). Absolute or ~. */
  addDirs?: string[];
  /**
   * Run as an agent defined by the target project itself (`<project>/.claude/agents/<name>.md`),
   * passed as `claude --agent <name>`. The project agent supplies persona, tools and model;
   * this DuskFleet agent only adds the unattended envelope (permissions, budget, MCP, extra prompt).
   */
  claudeAgent?: string;
  /**
   * Project this agent belongs to (an id from projects.yaml). Groups the agent under that
   * project, makes it the default for run_agent, and refuses runs on any other project.
   * Unset = general-purpose agent, runs anywhere.
   */
  project?: string;
  /** Markdown body of the agent file. Sent via --append-system-prompt when non-empty. */
  systemPrompt: string;
  /** Absolute path of the file this agent was loaded from. */
  sourcePath: string;
}

export interface ProjectDefinition {
  id: string;
  /** Absolute, resolved path. */
  path: string;
  description?: string;
  /** Same as AgentDefinition.inheritMcp; a run inherits MCP when either the agent or the project says so. */
  inheritMcp?: boolean;
  /** Extra directories every run on this project may access (--add-dir). Absolute, resolved. */
  addDirs?: string[];
}

export interface ClaudeConfig {
  binary: string | null;
  strictMcpConfig: boolean;
  /** Passed as --setting-sources when set (e.g. ["project","local"]). null = Claude's default (all sources). */
  settingSources: string[] | null;
  allowBypassPermissions: boolean;
  defaultTimeoutMinutes: number;
  defaultMaxBudgetUsd: number;
}

export interface SchedulerConfig {
  /** Kill switch: false stops every process from firing schedules (re-read every tick). */
  enabled: boolean;
  tickSeconds: number;
  /** Default IANA zone for new schedules. */
  defaultTimeZone: string;
}

export interface DuskFleetConfig {
  /** Directory containing duskfleet.yaml. */
  configDir: string;
  dataDir: string;
  /** Writable directory for agents created at runtime. Defaults to <dataDir>/agents. */
  userAgentsDir: string;
  /** Private project registry merged over config/projects.yaml. Defaults to <dataDir>/projects.yaml. */
  userProjectsFile: string;
  allowedProjectRoots: string[];
  /** Agent used when run_agent gets no agent_id. null = agent_id is required. */
  defaultAgent: string | null;
  maxConcurrentRuns: number;
  /** Runs allowed at the same time on one project directory (same working copy). Default 1. */
  maxConcurrentPerProject: number;
  /** Runs of the same agent allowed at the same time (the agent's WIP limit). Default 1. */
  maxConcurrentPerAgent: number;
  claude: ClaudeConfig;
  scheduler: SchedulerConfig;
  agents: Map<string, AgentDefinition>;
  projects: Map<string, ProjectDefinition>;
}
