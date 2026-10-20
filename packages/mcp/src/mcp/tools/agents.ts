import path from "node:path";
import {
  AGENT_ID_PATTERN,
  type AgentDefinition,
  type AgentSpec,
  agentKind,
  agentSpecSchema,
  agentToSpec,
  assertAgentKind,
  assertAgentSpecClean,
  assertWrapUpReserve,
  budgetPlan,
  type DuskFleetConfig,
  deleteAgentFile,
  EFFORT_LEVELS,
  listProjectAgents,
  loadAgents,
  ON_FAILURE_POLICIES,
  PERMISSION_MODES,
  projectIdFromPath,
  upsertUserProject,
  validateProjectPath,
  writeAgentFile,
} from "@duskfleet/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, jsonResult, type ToolContext } from "../server.js";

/** Permission modes a tool may set. bypassPermissions stays a hand-edited, config-gated choice. */
const MCP_PERMISSION_MODES = PERMISSION_MODES.filter((m) => m !== "bypassPermissions") as [string, ...string[]];

/** Validate what the loader would reject, *before* a file lands on disk and breaks every later config load. */
function assertSpecLoadable(spec: AgentSpec, config: DuskFleetConfig): void {
  if (spec.project && !config.projects.has(spec.project)) {
    throw new Error(
      `project "${spec.project}" is not in projects.yaml. Known projects: ${[...config.projects.keys()].join(", ") || "(none)"}`,
    );
  }
}

function assertKind(kind: "own" | "link", spec: AgentSpec, config: DuskFleetConfig): void {
  assertAgentKind(kind, spec, (id) => config.projects.get(id)?.path ?? null);
  assertWrapUpReserve(spec, config.claude.defaultMaxBudgetUsd);
}

/**
 * A link points at a FOLDER that defines agents. Resolve it to a registered project:
 * reuse the entry with the same path, or register the folder in the private registry
 * (user_projects_file) under `project` or a slug of the folder name. Returns the id.
 */
function projectFromFolder(
  ctx: ToolContext,
  config: DuskFleetConfig,
  projectPath: string,
  preferredId: string | undefined,
  claudeAgent: string | undefined,
): string {
  const resolved = validateProjectPath(projectPath, config);
  const agents = listProjectAgents(resolved);
  if (agents.length === 0) {
    throw new Error(
      `${resolved} has no .claude/agents/ directory with agents. A link must point to a project folder that defines agents.`,
    );
  }
  if (claudeAgent && !agents.some((a) => a.name === claudeAgent)) {
    throw new Error(
      `${resolved}/.claude/agents has no agent "${claudeAgent}" (available: ${agents.map((a) => a.name).join(", ")})`,
    );
  }
  const existing = [...config.projects.values()].find((p) => p.path === resolved);
  if (existing) {
    if (preferredId && preferredId !== existing.id) {
      throw new Error(`${resolved} is already registered as project "${existing.id}"; use that id or omit project.`);
    }
    return existing.id;
  }
  const id = preferredId ?? projectIdFromPath(resolved);
  if (config.projects.has(id)) {
    throw new Error(
      `project id "${id}" already points to ${config.projects.get(id)!.path}; pass project with a different id for ${resolved}.`,
    );
  }
  upsertUserProject(config.userProjectsFile, {
    id,
    path: resolved,
    description: `Registered by create_agent (link) from ${resolved}`,
  });
  const fresh = ctx.config; // reload: the new project must be visible before the agent file is validated
  if (!fresh.projects.has(id))
    throw new Error(`project "${id}" was written to ${config.userProjectsFile} but did not load`);
  return id;
}

/** Write the agent file, then make sure the config still loads; otherwise remove the file and fail loudly. */
function writeAndVerify(ctx: ToolContext, config: DuskFleetConfig, spec: AgentSpec): AgentDefinition {
  assertSpecLoadable(spec, config);
  const file = writeAgentFile(config.userAgentsDir, spec);
  const reloaded = ctx.config; // triggers a reload; on failure the previous config is kept
  const fresh = reloaded.agents.get(spec.id);
  if (!fresh || fresh.sourcePath !== file) {
    deleteAgentFile(config.userAgentsDir, spec.id);
    throw new Error(`agent file ${file} did not load (see server log); it has been removed again`);
  }
  return fresh;
}

function presentAgent(a: AgentDefinition, config: DuskFleetConfig) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    source: a.source,
    /** "own" = persona defined in DuskFleet; "link" = reuses the project's .claude/agents/<claudeAgent>.md */
    kind: agentKind(a),
    model: a.model ?? null,
    permissionMode: a.permissionMode,
    allowedTools: a.allowedTools ?? [],
    disallowedTools: a.disallowedTools ?? [],
    effort: a.effort ?? null,
    timeoutMinutes: a.timeoutMinutes ?? config.claude.defaultTimeoutMinutes,
    maxBudgetUsd: a.maxBudgetUsd ?? config.claude.defaultMaxBudgetUsd,
    /** Dollars of maxBudgetUsd kept for the wrap-up pass after a budget exhaustion (0 = no wrap-up). */
    wrapUpReserveUsd: budgetPlan(a, config).reserve,
    onFailure: a.onFailure ?? "none",
    resumeBudgetUsd: a.resumeBudgetUsd ?? null,
    inheritMcp: a.inheritMcp ?? false,
    addDirs: a.addDirs ?? [],
    claudeAgent: a.claudeAgent ?? null,
    project: a.project ?? null,
    /** Runs of this agent allowed at once: its own max_concurrent, else the global max_concurrent_per_agent. */
    maxConcurrent: a.maxConcurrent ?? config.maxConcurrentPerAgent,
    isolated: a.isolated ?? false,
    /** Daily caps (UTC day); null = no cap. */
    maxDailyRuns: a.maxDailyRuns ?? null,
    maxDailyCostUsd: a.maxDailyCostUsd ?? null,
    systemPrompt: a.systemPrompt,
    path: a.sourcePath,
  };
}

const agentFields = {
  name: z.string().min(1).optional().describe("Display name; defaults to the id"),
  description: z.string().optional().describe("One or two sentences: what the agent is for. Shown by list_agents"),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Claude model alias or id (haiku, sonnet, opus, ...). Omit to use the CLI default, which can be the most expensive model",
    ),
  permission_mode: z
    .enum(MCP_PERMISSION_MODES)
    .optional()
    .describe(
      "acceptEdits (default) | dontAsk | plan | auto | manual. Unattended runs get no prompts: anything not allowed is denied",
    ),
  allowed_tools: z
    .array(z.string().min(1))
    .optional()
    .describe('Claude Code --allowedTools entries, e.g. "Bash(npm test:*)". Needed for Bash under acceptEdits'),
  disallowed_tools: z.array(z.string().min(1)).optional().describe('e.g. ["Edit","Write"] for a read-only agent'),
  effort: z.enum(EFFORT_LEVELS).optional().describe("Claude Code --effort level; omit for the CLI default"),
  timeout_minutes: z
    .number()
    .positive()
    .optional()
    .describe("Kill the run after this many minutes; defaults to claude.default_timeout_minutes"),
  max_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Stop the run when its cost reaches this amount; defaults to claude.default_max_budget_usd"),
  wrap_up_reserve_usd: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Part of max_budget_usd held back for a wrap-up pass: when the main pass runs out of budget the session is resumed with this amount and told to record where it stopped. Default 10% of the budget, at least $0.50, at most half of it; 0 disables",
    ),
  on_failure: z
    .enum(ON_FAILURE_POLICIES)
    .optional()
    .describe(
      "resume_once: a schedule's next tick resumes a run of this agent that ended budget_exhausted or timed_out, once (a second failure is final). Default none. A schedule can override it",
    ),
  resume_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Budget of the resumed run (on_failure: resume_once); defaults to max_budget_usd"),
  inherit_mcp: z
    .boolean()
    .optional()
    .describe(
      'Let runs use the MCP servers of the DuskFleet user (claude.ai connectors like Atlassian/Figma). Default false. Each server still needs an allowed_tools entry such as "mcp__claude_ai_Atlassian_Rovo"',
    ),
  add_dirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Extra directories the run may access (--add-dir); runs are otherwise confined to the project directory"),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Bind the agent to a project id from list_projects: it is grouped under it, run_agent uses it by default, and runs on other projects are refused. Omit for a general-purpose agent",
    ),
  project_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "For kind 'link': absolute path of the project FOLDER that defines agents in .claude/agents/. If that folder is not a registered project yet it is registered in the private registry (id = `project` if given, else the folder name) and the agent is bound to it",
    ),
  claude_agent: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Reuse an agent the target project already defines in .claude/agents/<name>.md (see list_project_agents): the run adopts its prompt, tools and model via `claude --agent`. This DuskFleet agent then only supplies the unattended envelope: permissions, allow-list, budget, MCP",
    ),
  max_concurrent: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Runs of this agent allowed at the same time (whole number >= 1). Omit for the global max_concurrent_per_agent (default 1). max_concurrent_runs stays the hard cap",
    ),
  isolated: z
    .boolean()
    .optional()
    .describe(
      "true = the agent never edits the project checkout (read-only, or works in its own git worktree): its runs neither count against nor wait for max_concurrent_per_project. A promise the prompt must keep; DuskFleet does not check it. Default false",
    ),
  max_daily_runs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Runs of this agent allowed per UTC day (whole number >= 1, every run started since 00:00 UTC counts). The next one is refused; a schedule records skipped_daily_cap. Omit for no cap",
    ),
  max_daily_cost_usd: z
    .number()
    .positive()
    .optional()
    .describe(
      "Spend of this agent allowed per UTC day: once the recorded cost of its runs since 00:00 UTC reaches it, the next run is refused (a schedule records skipped_daily_cap). A run in progress is not stopped. Omit for no cap",
    ),
  system_prompt: z.string().optional().describe("Appended to Claude Code's system prompt for every run of this agent"),
};

export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "List the agent definitions available: builtin ones from config/agents and user ones from user_agents_dir. " +
        "Use an agent's id with run_agent.",
      inputSchema: {},
    },
    async () => {
      const config = ctx.config;
      const agents = [...config.agents.values()].map((a) => presentAgent(a, config));
      const byProject: Record<string, string[]> = {};
      for (const a of agents) (byProject[a.project ?? "(any project)"] ??= []).push(a.id);
      return jsonResult({
        defaultAgent: config.defaultAgent,
        userAgentsDir: config.userAgentsDir,
        byProject,
        agents,
      });
    },
  );

  server.registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent. FIRST decide its kind: " +
        "'own' = a NEW agent whose persona you write here (system_prompt required, no claude_agent); " +
        "'link' = a LINK to an agent the target project already defines in .claude/agents/<name>.md " +
        "(claude_agent + project required; check list_project_agents first). A link reuses the project's prompt, tools and model " +
        "and only adds the unattended envelope: permission_mode, allowed_tools, budget, inherit_mcp, optional extra instructions in system_prompt. " +
        "The file is written to user_agents_dir (outside the repo) and is available to run_agent immediately. " +
        "Fails if the id exists unless overwrite is true; overwriting a builtin id creates a user override. bypassPermissions cannot be set here.",
      inputSchema: {
        id: z.string().regex(AGENT_ID_PATTERN).describe("Lowercase letters, digits, - or _. Also the file name"),
        kind: z
          .enum(["own", "link"])
          .describe(
            "REQUIRED choice. 'own': new agent, persona in system_prompt. 'link': reuse <folder>/.claude/agents/<claude_agent>.md; requires claude_agent plus the folder as project_path (or an already registered project id)",
          ),
        ...agentFields,
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace an existing user agent or override a builtin one with the same id"),
      },
    },
    async (args) => {
      try {
        const config = ctx.config;
        const existing = config.agents.get(args.id);
        if (existing && !args.overwrite) {
          return errorResult(
            new Error(
              existing.source === "user"
                ? `agent "${args.id}" already exists (${existing.sourcePath}). Use update_agent, or pass overwrite: true to replace it.`
                : `"${args.id}" is a builtin agent (${existing.sourcePath}). Pass overwrite: true to create a user override, or choose another id.`,
            ),
          );
        }
        const { overwrite: _o, kind, project_path, ...fields } = args;
        let registeredProject: string | null = null;
        if (project_path) {
          fields.project = projectFromFolder(ctx, config, project_path, fields.project, fields.claude_agent);
          registeredProject = fields.project;
        }
        const cfg = ctx.config;
        const spec = assertAgentSpecClean(agentSpecSchema.parse(fields));
        assertKind(kind, spec, cfg);
        const fresh = writeAndVerify(ctx, cfg, spec);
        return jsonResult({
          created: true,
          kind,
          overrode: existing?.source ?? null,
          ...(registeredProject ? { project: cfg.projects.get(registeredProject) } : {}),
          agent: presentAgent(fresh, ctx.config),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_agent",
    {
      title: "Update agent",
      description:
        "Change fields of a user agent; omitted fields keep their value. The agent keeps its kind unless you pass one: " +
        "kind 'link' (with claude_agent, project) turns an own agent into a link; kind 'own' (with a system_prompt) or clear: [\"claude_agent\"] " +
        "turns a link back into an own agent. Builtin agents are versioned in config/agents and are not edited by tools: " +
        "create_agent with the same id and overwrite: true makes a user override instead.",
      inputSchema: {
        id: z.string().regex(AGENT_ID_PATTERN).describe("Agent id from list_agents (user agents only)"),
        kind: z
          .enum(["own", "link"])
          .optional()
          .describe("Change the kind; the resulting agent is validated like create_agent"),
        ...agentFields,
        clear: z
          .array(
            z.enum([
              "model",
              "allowed_tools",
              "disallowed_tools",
              "effort",
              "timeout_minutes",
              "max_budget_usd",
              "wrap_up_reserve_usd",
              "on_failure",
              "resume_budget_usd",
              "inherit_mcp",
              "add_dirs",
              "claude_agent",
              "project",
              "max_daily_runs",
              "max_daily_cost_usd",
            ]),
          )
          .optional()
          .describe("Optional fields to remove entirely (fall back to agent/CLI defaults)"),
      },
    },
    async (args) => {
      try {
        const config = ctx.config;
        const existing = config.agents.get(args.id);
        if (!existing)
          return errorResult(new Error(`unknown agent "${args.id}". Known: ${[...config.agents.keys()].join(", ")}`));
        if (existing.source !== "user") {
          return errorResult(
            new Error(
              `"${args.id}" is a builtin agent (${existing.sourcePath}). Use create_agent with overwrite: true to create a user override.`,
            ),
          );
        }
        const { id: _id, clear, kind: requestedKind, project_path, ...changes } = args;
        if (project_path)
          changes.project = projectFromFolder(
            ctx,
            config,
            project_path,
            changes.project,
            changes.claude_agent ?? existing.claudeAgent,
          );
        const cfgNow = ctx.config;
        const merged: AgentSpec = { ...agentToSpec(existing) };
        for (const [k, v] of Object.entries(changes)) if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
        for (const k of clear ?? []) delete (merged as Record<string, unknown>)[k];
        const spec = assertAgentSpecClean(agentSpecSchema.parse(merged));
        const kind = requestedKind ?? agentKind(spec);
        assertKind(kind, spec, cfgNow);
        const fresh = writeAndVerify(ctx, cfgNow, spec);
        return jsonResult({ updated: true, kind, agent: presentAgent(fresh, ctx.config) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_agent",
    {
      title: "Delete agent",
      description:
        "Delete a user agent file. Builtin agents cannot be deleted. Past runs keep their recorded agent id.",
      inputSchema: {
        id: z
          .string()
          .regex(AGENT_ID_PATTERN)
          .describe("Agent id from list_agents. Only user agents (data/agents) can be deleted"),
      },
    },
    async (args) => {
      try {
        const config = ctx.config;
        const existing = config.agents.get(args.id);
        if (!existing) return errorResult(new Error(`unknown agent "${args.id}"`));
        if (existing.source !== "user")
          return errorResult(
            new Error(`"${args.id}" is a builtin agent (${existing.sourcePath}) and cannot be deleted through MCP.`),
          );
        // The default agent must keep resolving: deleting a user override is fine when a builtin remains.
        const builtinRemains = loadAgents(path.join(config.configDir, "agents"), "builtin").has(args.id);
        if (args.id === config.defaultAgent && !builtinRemains) {
          return errorResult(
            new Error(
              `"${args.id}" is the default_agent in duskfleet.yaml and has no builtin fallback; change default_agent first.`,
            ),
          );
        }
        deleteAgentFile(config.userAgentsDir, args.id);
        const after = ctx.config.agents.get(args.id);
        return jsonResult({ deleted: true, nowResolvesTo: after ? presentAgent(after, ctx.config) : null });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_project_agents",
    {
      title: "List project agents",
      description:
        "List the Claude Code agents a project defines in .claude/agents/*.md (name, description, tools, model). " +
        "Pass one of these names as claude_agent to create_agent to reuse it instead of writing a new persona.",
      inputSchema: {
        project_id: z.string().optional().describe("Id from list_projects"),
        project_path: z.string().optional().describe("Absolute project path; alternative to project_id"),
      },
    },
    async (args) => {
      try {
        const config = ctx.config;
        let projectPath: string;
        if (args.project_id) {
          const p = config.projects.get(args.project_id);
          if (!p)
            return errorResult(
              new Error(`unknown project "${args.project_id}". Known: ${[...config.projects.keys()].join(", ")}`),
            );
          projectPath = p.path;
        } else if (args.project_path) {
          projectPath = validateProjectPath(args.project_path, config);
        } else {
          return errorResult(new Error("project_id or project_path is required"));
        }
        const agents = listProjectAgents(projectPath);
        return jsonResult({
          projectPath,
          agents,
          hint: agents.length
            ? "Reuse one with create_agent { id, claude_agent: <name>, permission_mode, allowed_tools, inherit_mcp }. Tool names in the project file that are not allow-listed here are denied in unattended runs."
            : "This project defines no .claude/agents. Write the persona in system_prompt instead.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List named projects from config/projects.yaml and the allowed project roots. " +
        "run_agent accepts either a project_id from this list or any validated absolute project_path.",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        allowedProjectRoots: ctx.config.allowedProjectRoots,
        projects: [...ctx.config.projects.values()],
        executor: ctx.executorInfo,
      }),
  );
}
