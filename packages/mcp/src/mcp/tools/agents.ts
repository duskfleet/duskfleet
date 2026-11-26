import path from "node:path";
import {
  AGENT_ID_PATTERN,
  type AgentDefinition,
  agentKind,
  agentSpecSchema,
  agentToSpec,
  assertAgentIdFree,
  assertAgentSpecClean,
  assertAgentWritable,
  budgetPlan,
  builtinHarnesses,
  CLAUDE_PROJECT_AGENTS,
  createAgentFromFields,
  type DuskFleetConfig,
  deleteAgentFile,
  deleteSkippedUserAgentFiles,
  EFFORT_LEVELS,
  effectiveAgentFields,
  envPassthroughSchema,
  harnessGrantWarnings,
  harnessNameSchema,
  harnessOf,
  linkFolder,
  linkProjectPath,
  linkRefusal,
  linkToolWarnings,
  listProjectAgents,
  loadAgentDir,
  MAX_TIMEOUT_MINUTES,
  ON_FAILURE_POLICIES,
  PERMISSION_MODES,
  projectAgentFile,
  projectAgentFolderOf,
  projectAgentGuidance,
  projectIdFromPath,
  SHIPPED_HARNESSES,
  sameDirectory,
  sandboxAllowedDomainsSchema,
  skillsSchema,
  skippedAgentError,
  skippedUserAgentFiles,
  timeoutMinutesSchema,
  upsertUserProject,
  validateProjectPath,
  writeAgentAndVerify,
} from "@duskfleet/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, jsonResult, type ToolContext } from "../server.js";

/** Permission modes a tool may set. bypassPermissions stays a hand-edited, config-gated choice. */
const MCP_PERMISSION_MODES = PERMISSION_MODES.filter((m) => m !== "bypassPermissions") as [string, ...string[]];

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
  link: { id: string; harness: string | undefined; claudeAgent: string | undefined },
): string {
  const lookup = ctx.runs.harnesses.lookup;
  // The harness first (#494): a link on a harness that cannot run one is refused with the remedy,
  // before the folder is searched for agents of another harness.
  const harness = harnessOf({ harness: link.harness });
  const refused = link.claudeAgent ? linkRefusal(harness, lookup) : null;
  if (refused) throw new Error(`agent "${link.id}": ${refused}`);
  const folder = projectAgentFolderOf(harness, lookup) ?? CLAUDE_PROJECT_AGENTS;
  const resolved = validateProjectPath(projectPath, config);
  const agents = listProjectAgents(resolved, folder);
  if (agents.length === 0) {
    throw new Error(
      `${resolved} has no ${folder.dir}/ directory with agents (harness ${harness}). A link must point to a project folder that defines agents for the agent's harness.`,
    );
  }
  if (link.claudeAgent && !agents.some((a) => a.name === link.claudeAgent)) {
    throw new Error(
      `${resolved}/${folder.dir} has no agent "${link.claudeAgent}" (available: ${agents.map((a) => a.name).join(", ")})`,
    );
  }
  const existing = [...config.projects.values()].find((p) => sameDirectory(p.path, resolved));
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
    description: "Registered by create_agent (link)",
  });
  const fresh = ctx.config; // reload: the new project must be visible before the agent file is validated
  if (!fresh.projects.has(id))
    throw new Error(`project "${id}" was written to ${config.userProjectsFile} but did not load`);
  return id;
}

/**
 * Advice that never refuses the write: a link's allowed_tools entries its project agent does not
 * declare, and what a Codex agent's codex_network / env_passthrough do and do not grant (#488).
 */
function agentWarnings(a: AgentDefinition, config: DuskFleetConfig): string[] {
  return [
    ...linkToolWarnings(
      { claude_agent: a.claudeAgent, allowed_tools: a.allowedTools },
      linkProjectPath(a, config.projects),
      linkFolder(a),
    ),
    ...harnessGrantWarnings(a),
  ];
}

function presentAgent(a: AgentDefinition, config: DuskFleetConfig) {
  // A link that leaves description / model out lists the project agent's (issue #459).
  const folder = linkFolder(a);
  const effective = effectiveAgentFields(a, linkProjectPath(a, config.projects), folder);
  return {
    id: a.id,
    name: a.name,
    description: effective.description,
    /** "agent" = this file, "project agent" = a link's project agent file (projectAgentFile), null = none. */
    descriptionSource: effective.descriptionSource,
    source: a.source,
    /** "own" = persona defined in Duskfleet; "link" = reuses the project's agent file (projectAgentFile) */
    kind: agentKind(a),
    model: effective.model,
    /** "agent" = this file, "project agent" = a link's project agent, null = the CLI default. */
    modelSource: effective.modelSource,
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
    /** The project agent a link runs (`project_agent:`, older name `claude_agent:`); null for an own agent. */
    projectAgent: a.claudeAgent ?? null,
    /** Same value as projectAgent, under its older name. */
    claudeAgent: a.claudeAgent ?? null,
    /** Where the agent's harness reads that project agent, relative to the project. */
    projectAgentFile: a.claudeAgent ? projectAgentFile(folder, a.claudeAgent) : null,
    project: a.project ?? null,
    /** Runs of this agent allowed at once: its own max_concurrent, else the global max_concurrent_per_agent. */
    maxConcurrent: a.maxConcurrent ?? config.maxConcurrentPerAgent,
    isolated: a.isolated ?? false,
    /** Daily caps (UTC day); null = no cap. */
    maxDailyRuns: a.maxDailyRuns ?? null,
    maxDailyCostUsd: a.maxDailyCostUsd ?? null,
    /** Variables this agent's runs get beyond the default allow-list (claude.env_passthrough adds to them). */
    envPassthrough: a.envPassthrough ?? [],
    /** Duskfleet skills (data/skills, config/skills) bundled into every run. */
    skills: a.skills ?? [],
    /** Bash runs inside Claude Code's sandbox: no writes outside the project and addDirs, network only to sandboxAllowedDomains. */
    sandbox: a.sandbox ?? false,
    sandboxAllowedDomains: a.sandboxAllowedDomains ?? [],
    /** enableWeakerNetworkIsolation in the sandbox settings: gh can verify TLS on macOS, isolation is weaker. */
    sandboxWeakerNetworkIsolation: a.sandboxWeakerNetworkIsolation ?? false,
    /** Codex only: the run's workspace-write sandbox has the network, every host (#488). */
    codexNetwork: a.codexNetwork ?? false,
    /** The agent CLI that runs it (`harness:`); claude unless the file says otherwise. */
    harness: harnessOf(a),
    systemPrompt: a.systemPrompt,
    path: a.sourcePath,
  };
}

/**
 * The `harness` parameter, described with the harnesses registered on this host (issue #477), so
 * a chat host (Claude Code, Claude Desktop, Copilot, Codex) can create an agent on any of them.
 */
export function harnessField(registered: readonly string[] | null) {
  const here = registered ? `; registered on this host: ${registered.join(", ") || "none"}` : "";
  return harnessNameSchema
    .optional()
    .describe(
      `Agent CLI that runs the agent: claude (default), copilot (GitHub Copilot CLI), codex (Codex CLI) or cursor (Cursor Agent CLI)${here}. ` +
        "The agent runs on its harness whatever MCP host asks. A field the harness cannot honour is refused by name, never dropped: " +
        "copilot takes Copilot's own tool rules in allowed_tools / disallowed_tools (not Claude rules) and has no dollar budget (no max_budget_usd); " +
        "codex has no tool rules, only its sandbox from permission_mode (dontAsk = read-only, acceptEdits = workspace-write); " +
        "cursor takes Cursor's own permission rules (Shell(<command>), Read(<glob>), Write(<glob>), WebFetch(<domain>); no Mcp(...): every MCP tool is denied), no dollar budget, no effort, and its system_prompt is sent as a marked block ahead of the task",
    );
}

/**
 * `project_path` and `claude_agent`, described with each harness's own project-agent folder
 * (`projectAgentGuidance`, issue #494) instead of one harness's folder for all.
 */
function linkFields(guidance: string) {
  return {
    project_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        `For kind 'link': absolute path of the project FOLDER that defines the agent in its harness's folder (${guidance}). If that folder is not a registered project yet it is registered in the private registry (id = \`project\` if given, else the folder name) and the agent is bound to it`,
      ),
    project_agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Reuse an agent the target project already defines for the agent's harness (${guidance}; see list_project_agents): the run adopts its prompt, tools and model (\`claude --agent\`, \`copilot --agent\`). This Duskfleet agent then only supplies the unattended envelope: permissions, allow-list, budget, MCP. On copilot the envelope cannot add instructions: leave system_prompt empty. A harness without links refuses it: use kind 'own' there`,
      ),
    claude_agent: z
      .string()
      .min(1)
      .optional()
      .describe("Older name of project_agent, same meaning. Set one or the other, never both"),
  };
}

const agentFields = {
  name: z.string().min(1).optional().describe("Display name; defaults to the id"),
  harness: harnessField(null),
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
  effort: z
    .enum(EFFORT_LEVELS)
    .optional()
    .describe(
      "Reasoning effort passed to the agent's harness CLI (refused on a harness without effort); omit for the CLI default. run_agent and schedules can override it per run",
    ),
  timeout_minutes: timeoutMinutesSchema("timeout_minutes")
    .optional()
    .describe(
      `Kill the run after this many minutes (at most ${MAX_TIMEOUT_MINUTES}); defaults to claude.default_timeout_minutes`,
    ),
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
      'Let runs use the MCP servers of the Duskfleet user (claude.ai connectors like Atlassian/Figma). Default false. Each server still needs an allowed_tools entry such as "mcp__claude_ai_Atlassian_Rovo"',
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
      "true = the agent never edits the project checkout (read-only, or works in its own git worktree): its runs neither count against nor wait for max_concurrent_per_project. A promise the prompt must keep; Duskfleet does not check it. Default false",
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
  env_passthrough: envPassthroughSchema
    .optional()
    .describe(
      'Environment variables (exact names or PREFIX_*) the runs get on top of the default allow-list (PATH, HOME, ANTHROPIC_*, CLAUDE_*...), e.g. ["GH_TOKEN"] for an agent that uses gh. Everything else in the server\'s environment is dropped',
    ),
  skills: skillsSchema
    .optional()
    .describe(
      "Duskfleet skills the runs get: names of folders with a SKILL.md in data/skills/ (private, wins) or config/skills/. Unknown names refuse the create/update. Delivered as a bundle passed with --add-dir; the project is never written. The project's own .claude/skills need nothing here",
    ),
  sandbox: z
    .boolean()
    .optional()
    .describe(
      "true = run the agent's Bash commands inside Claude Code's native sandbox (macOS Seatbelt, Linux bubblewrap): no writes outside the project and add_dirs, no network except sandbox_allowed_domains. A host without the sandbox refuses the run, never runs it unsandboxed. Default false",
    ),
  sandbox_allowed_domains: sandboxAllowedDomainsSchema
    .optional()
    .describe(
      'Exact host names a sandboxed run may reach, e.g. ["github.com", "api.github.com", "registry.npmjs.org"]. Needs sandbox: true. Omit for no network at all',
    ),
  sandbox_weaker_network_isolation: z
    .boolean()
    .optional()
    .describe(
      "true = add enableWeakerNetworkIsolation to the sandbox settings: on macOS, gh (and other Go tools) can then verify TLS inside the sandbox; without it every gh call fails with an x509 error. Weakens the network isolation for every command of the run. Needs sandbox: true. Default false",
    ),
  codex_network: z
    .boolean()
    .optional()
    .describe(
      "harness codex only, permission_mode acceptEdits only: true = the run's workspace-write sandbox gets the network, EVERY host (Codex has no host or tool allow-list), and its commands act with the credentials of the user who runs Duskfleet (gh login, SSH keys): it can push wherever that login can. Needed to push, open pull requests or install. Default false (network off)",
    ),
  system_prompt: z.string().optional().describe("Appended to Claude Code's system prompt for every run of this agent"),
};

export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  // The tool catalogue registers with an empty context: the harness list is then left out.
  const harness = harnessField(ctx.runs?.harnesses.names() ?? null);
  // Project-agent folders of the harnesses registered here (the shipped ones in the catalogue).
  const guidance = projectAgentGuidance(
    ctx.runs?.harnesses.names() ?? SHIPPED_HARNESSES,
    ctx.runs?.harnesses.lookup ?? builtinHarnesses,
  );
  const link = linkFields(guidance);
  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "List the agent definitions available: builtin ones from config/agents and user ones from user_agents_dir. " +
        "Use an agent's id with run_agent. skippedAgents lists the agent files that do not load (path and error): " +
        "their ids are unavailable, never replaced by a builtin of the same id, until the file is fixed.",
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
        // Files the loader could not load: their ids are unavailable until fixed (#462).
        skippedAgents: (config.skippedAgents ?? []).map((s) => ({
          id: s.id,
          source: s.source,
          sourcePath: s.sourcePath,
          error: s.error,
        })),
      });
    },
  );

  server.registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent. FIRST decide its kind: " +
        "'own' = a NEW agent whose persona you write here (system_prompt required, no project_agent); " +
        "'link' = a LINK to an agent the target project already defines for the agent's harness " +
        `(${guidance}; project_agent + project required; check list_project_agents with the same harness first). A link reuses the project's prompt, tools and model ` +
        "and only adds the unattended envelope: permission_mode, allowed_tools, budget, inherit_mcp, optional extra instructions in system_prompt (claude only: a copilot link has no body). " +
        "A harness without links takes kind 'own' only. " +
        "The file is written to user_agents_dir (outside the repo) and is available to run_agent immediately. " +
        "Fails if the id exists unless overwrite is true; overwriting a builtin id creates a user override. bypassPermissions cannot be set here.",
      inputSchema: {
        id: z.string().regex(AGENT_ID_PATTERN).describe("Lowercase letters, digits, - or _. Also the file name"),
        kind: z
          .enum(["own", "link"])
          .describe(
            "REQUIRED choice. 'own': new agent, persona in system_prompt. 'link': reuse the agent <project_agent> the project defines in its harness's folder (see project_agent); requires project_agent plus the folder as project_path (or an already registered project id)",
          ),
        ...agentFields,
        ...link,
        harness,
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace an existing user agent or override a builtin one with the same id"),
      },
    },
    async (args) => {
      try {
        const config = ctx.config;
        const existing = assertAgentIdFree(config, args.id, args.overwrite ?? false, "overwrite: true", "update_agent");
        const { overwrite: _o, kind, project_path, ...fields } = args;
        let registeredProject: string | null = null;
        if (project_path) {
          fields.project = projectFromFolder(ctx, config, project_path, fields.project, {
            id: args.id,
            harness: fields.harness,
            claudeAgent: fields.project_agent ?? fields.claude_agent,
          });
          registeredProject = fields.project;
        }
        const cfg = ctx.config;
        const fresh = createAgentFromFields(kind, fields, cfg, () => ctx.config, ctx.runs.harnesses.lookup);
        const after = ctx.config;
        return jsonResult({
          created: true,
          kind,
          overrode: existing?.source ?? null,
          ...(registeredProject ? { project: cfg.projects.get(registeredProject) } : {}),
          agent: presentAgent(fresh, after),
          warnings: agentWarnings(fresh, after),
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
        "kind 'link' (with project_agent, project) turns an own agent into a link; kind 'own' (with a system_prompt) or clear: [\"project_agent\"] " +
        "turns a link back into an own agent. Builtin agents are versioned in config/agents and are not edited by tools: " +
        "create_agent with the same id and overwrite: true makes a user override instead.",
      inputSchema: {
        id: z.string().regex(AGENT_ID_PATTERN).describe("Agent id from list_agents (user agents only)"),
        kind: z
          .enum(["own", "link"])
          .optional()
          .describe("Change the kind; the resulting agent is validated like create_agent"),
        ...agentFields,
        ...link,
        harness,
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
              "project_agent",
              "claude_agent",
              "project",
              "max_daily_runs",
              "max_daily_cost_usd",
              "env_passthrough",
              "skills",
              "sandbox",
              "sandbox_allowed_domains",
              "sandbox_weaker_network_isolation",
              "codex_network",
              "harness",
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
        if (!existing) {
          const skipped = skippedAgentError(config, args.id);
          return errorResult(
            new Error(
              skipped
                ? `${skipped}. Fix the file by hand, delete it with delete_agent, or replace it with create_agent and overwrite: true.`
                : `unknown agent "${args.id}". Known: ${[...config.agents.keys()].join(", ")}`,
            ),
          );
        }
        if (existing.source !== "user") {
          return errorResult(
            new Error(
              `"${args.id}" is a builtin agent (${existing.sourcePath}). Use create_agent with overwrite: true to create a user override.`,
            ),
          );
        }
        const { id: _id, clear, kind: requestedKind, project_path, ...changes } = args;
        if (project_path)
          changes.project = projectFromFolder(ctx, config, project_path, changes.project, {
            id: args.id,
            harness: changes.harness ?? (clear?.includes("harness") ? undefined : existing.harness),
            claudeAgent:
              changes.project_agent ??
              changes.claude_agent ??
              (clear?.includes("claude_agent") || clear?.includes("project_agent") ? undefined : existing.claudeAgent),
          });
        const cfgNow = ctx.config;
        const stored = agentToSpec(existing);
        const merged: Record<string, unknown> = { ...stored };
        // The stored link field is `claude_agent`: a value under its new name replaces it.
        if (changes.project_agent !== undefined) delete merged["claude_agent"];
        for (const [k, v] of Object.entries(changes)) if (v !== undefined) merged[k] = v;
        // Either name clears the one field.
        for (const k of clear ?? []) {
          delete merged[k];
          if (k === "project_agent") delete merged["claude_agent"];
        }
        const spec = assertAgentSpecClean(agentSpecSchema.parse(merged));
        const kind = requestedKind ?? agentKind(spec);
        assertAgentWritable(kind, spec, cfgNow, stored.skills ?? [], ctx.runs.harnesses.lookup);
        const fresh = writeAgentAndVerify(cfgNow, spec, () => ctx.config);
        const after = ctx.config;
        return jsonResult({
          updated: true,
          kind,
          agent: presentAgent(fresh, after),
          warnings: agentWarnings(fresh, after),
        });
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
        // A user file that does not load (#462) is deleted by path: its name may differ from its id.
        const broken = existing ? [] : skippedUserAgentFiles(config, args.id);
        if (!existing && !broken.length)
          return errorResult(new Error(skippedAgentError(config, args.id) ?? `unknown agent "${args.id}"`));
        if (existing && existing.source !== "user")
          return errorResult(
            new Error(`"${args.id}" is a builtin agent (${existing.sourcePath}) and cannot be deleted through MCP.`),
          );
        // The default agent must keep resolving: deleting a user override is fine when a builtin remains.
        // Lenient read: one broken builtin file must not break the delete of another agent.
        const builtinRemains = loadAgentDir(path.join(config.configDir, "agents"), "builtin").agents.has(args.id);
        if (args.id === config.defaultAgent && !builtinRemains) {
          return errorResult(
            new Error(
              `"${args.id}" is the default_agent in duskfleet.yaml and has no builtin fallback; change default_agent first.`,
            ),
          );
        }
        let removedFiles: string[];
        if (broken.length) {
          removedFiles = deleteSkippedUserAgentFiles(config, args.id);
        } else {
          deleteAgentFile(config.userAgentsDir, args.id);
          removedFiles = existing ? [existing.sourcePath] : [];
        }
        const after = ctx.config.agents.get(args.id);
        return jsonResult({
          deleted: true,
          files: removedFiles,
          nowResolvesTo: after ? presentAgent(after, ctx.config) : null,
        });
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
        `List the agents a project defines for one harness, in that harness's own folder (${guidance}): name, description, tools, model. ` +
        "When linkable is true, pass one of these names as project_agent to create_agent (same harness) to reuse it instead of writing a new persona; " +
        "when false, the harness cannot run a link: use kind 'own'.",
      inputSchema: {
        project_id: z.string().optional().describe("Id from list_projects"),
        project_path: z.string().optional().describe("Absolute project path; alternative to project_id"),
        harness: harnessNameSchema
          .optional()
          .describe("The harness whose folder is read; default claude, as create_agent. Only that folder is read"),
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
        const harness = harnessOf({ harness: args.harness });
        const caps = ctx.runs.harnesses.lookup(harness);
        if (!caps)
          return errorResult(
            new Error(
              `unknown harness "${harness}": no executor is registered under that name (registered: ${ctx.runs.harnesses.names().join(", ")})`,
            ),
          );
        const folder = caps.projectAgentFolder;
        const agents = folder ? listProjectAgents(projectPath, folder) : [];
        const where = folder ? `${folder.dir}/` : "no project-agent folder";
        const linkable = caps.projectAgents && folder !== undefined;
        return jsonResult({
          projectPath,
          harness,
          folder: folder ? projectAgentFile(folder) : null,
          linkable,
          agents,
          hint: !linkable
            ? `Harness ${harness} cannot run a link yet (its agents live in ${where}): use kind "own" on harness ${harness}, the persona goes in system_prompt.`
            : agents.length
              ? `Reuse one with create_agent { id, kind: "link", harness: "${harness}", project_agent: <name>, permission_mode, allowed_tools${caps.projectAgentInstructions === false ? " } and no system_prompt (this harness takes nothing next to a project agent)" : ", inherit_mcp }"}. Tool names in the project file that are not allow-listed here are denied in unattended runs.`
              : `This project defines no agents in ${where} (harness ${harness}). Write the persona in system_prompt (kind "own") instead.`,
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
