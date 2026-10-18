import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AGENT_ID_PATTERN, maxConcurrentSchema } from "./agent-files.js";
import {
  type AgentDefinition,
  type AgentSource,
  type DuskFleetConfig,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type ProjectDefinition,
} from "./types.js";

/**
 * Locates the config directory.
 *   1. DUSKFLEET_CONFIG env var (path to a directory containing duskfleet.yaml)
 *   2. <repo root>/config, where the repo root is the closest ancestor of
 *      `startFrom` (a file URL or a path) that contains config/duskfleet.yaml
 */
export function resolveConfigDir(startFrom: string = process.cwd()): string {
  const fromEnv = process.env["DUSKFLEET_CONFIG"];
  if (fromEnv) return expandHome(fromEnv);
  const root = findRepoRoot(startFrom);
  if (!root) {
    throw new Error(
      `Could not find config/duskfleet.yaml walking up from ${startFrom}. Set DUSKFLEET_CONFIG to the config directory.`,
    );
  }
  return path.join(root, "config");
}

/** Walks up from a path or file URL until a directory containing config/duskfleet.yaml is found. */
export function findRepoRoot(startFrom: string): string | null {
  let dir = startFrom.startsWith("file:") ? path.dirname(fileURLToPath(startFrom)) : startFrom;
  if (!isDirectory(dir)) dir = path.dirname(dir);
  for (;;) {
    if (existsSync(path.join(dir, "config", "duskfleet.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

const globalSchema = z.object({
  data_dir: z.string().default("../data"),
  user_agents_dir: z.string().nullable().default(null),
  user_projects_file: z.string().nullable().default(null),
  allowed_project_roots: z.array(z.string()).default([]),
  default_agent: z.string().nullable().default(null),
  max_concurrent_runs: z.number().int().positive().default(2),
  max_concurrent_per_project: z.number().int().positive().default(1),
  max_concurrent_per_agent: z.number().int().positive().default(1),
  claude: z
    .object({
      binary: z.string().nullable().default(null),
      strict_mcp_config: z.boolean().default(true),
      setting_sources: z
        .array(z.enum(["user", "project", "local"]))
        .nullable()
        .default(null),
      allow_bypass_permissions: z.boolean().default(false),
      default_timeout_minutes: z.number().positive().default(30),
      default_max_budget_usd: z.number().positive().default(5),
    })
    .prefault({}),
  scheduler: z
    .object({
      enabled: z.boolean().default(true),
      tick_seconds: z.number().int().min(5).max(300).default(30),
      default_time_zone: z.string().default("Europe/London"),
    })
    .prefault({}),
});

const agentFrontmatterSchema = z.object({
  id: z.string().regex(AGENT_ID_PATTERN, "agent id must be lowercase letters, digits, - or _").optional(),
  name: z.string().optional(),
  description: z.string().default(""),
  model: z.string().optional(),
  permission_mode: z.enum(PERMISSION_MODES).default("acceptEdits"),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  timeout_minutes: z.number().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  wrap_up_reserve_usd: z.number().nonnegative().optional(),
  inherit_mcp: z.boolean().optional(),
  add_dirs: z.array(z.string()).optional(),
  claude_agent: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  max_concurrent: maxConcurrentSchema.optional(),
  isolated: z.boolean().optional(),
});

const projectsSchema = z.object({
  projects: z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        description: z.string().optional(),
        inherit_mcp: z.boolean().optional(),
        add_dirs: z.array(z.string()).optional(),
      }),
    )
    .default({}),
});

export function loadConfig(configDir: string): DuskFleetConfig {
  const globalPath = path.join(configDir, "duskfleet.yaml");
  if (!existsSync(globalPath)) {
    throw new Error(`Config file not found: ${globalPath}`);
  }
  const raw = parseYaml(readFileSync(globalPath, "utf8")) ?? {};
  const g = globalSchema.parse(raw);

  const dataDir = path.resolve(configDir, expandHome(g.data_dir));
  const allowedProjectRoots = g.allowed_project_roots.map((r) => path.resolve(configDir, expandHome(r)));

  const userAgentsDir = g.user_agents_dir
    ? path.resolve(configDir, expandHome(g.user_agents_dir))
    : path.join(dataDir, "agents");

  // Builtin agents ship with the repo; user agents are created at runtime and
  // override a builtin with the same id.
  const agents = loadAgents(path.join(configDir, "agents"), "builtin");
  for (const [id, agent] of loadAgents(userAgentsDir, "user")) agents.set(id, agent);
  // Projects: the versioned registry plus a private one next to the data (machine-specific
  // absolute paths never belong in the repo). Same id = the private entry wins.
  const projects = loadProjects(path.join(configDir, "projects.yaml"), configDir);
  const userProjectsFile = g.user_projects_file
    ? path.resolve(configDir, expandHome(g.user_projects_file))
    : path.join(dataDir, "projects.yaml");
  for (const [id, p] of loadProjects(userProjectsFile, path.dirname(userProjectsFile))) projects.set(id, p);

  for (const a of agents.values()) {
    if (a.project && !projects.has(a.project)) {
      throw new Error(
        `agent "${a.id}" (${a.sourcePath}) belongs to project "${a.project}", which is not in projects.yaml. Known projects: ${[...projects.keys()].join(", ") || "(none)"}`,
      );
    }
  }
  if (g.default_agent !== null && !agents.has(g.default_agent)) {
    throw new Error(
      `default_agent "${g.default_agent}" not found. Known agents: ${[...agents.keys()].join(", ") || "(none)"}`,
    );
  }

  return {
    configDir,
    dataDir,
    userAgentsDir,
    userProjectsFile,
    allowedProjectRoots,
    defaultAgent: g.default_agent,
    maxConcurrentRuns: g.max_concurrent_runs,
    maxConcurrentPerProject: g.max_concurrent_per_project,
    maxConcurrentPerAgent: g.max_concurrent_per_agent,
    claude: {
      binary: g.claude.binary ? expandHome(g.claude.binary) : null,
      strictMcpConfig: g.claude.strict_mcp_config,
      settingSources: g.claude.setting_sources,
      allowBypassPermissions: g.claude.allow_bypass_permissions,
      defaultTimeoutMinutes: g.claude.default_timeout_minutes,
      defaultMaxBudgetUsd: g.claude.default_max_budget_usd,
    },
    scheduler: {
      enabled: g.scheduler.enabled,
      tickSeconds: g.scheduler.tick_seconds,
      defaultTimeZone: g.scheduler.default_time_zone,
    },
    agents,
    projects,
  };
}

/**
 * Agent files are Markdown with YAML frontmatter:
 *
 *   ---
 *   id: my-agent
 *   permission_mode: acceptEdits
 *   ---
 *   System prompt body...
 */
export function loadAgents(agentsDir: string, source: AgentSource = "builtin"): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();
  if (!existsSync(agentsDir)) return agents;

  for (const file of readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const sourcePath = path.join(agentsDir, file);
    const { frontmatter, body } = splitFrontmatter(readFileSync(sourcePath, "utf8"));
    const parsed = agentFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(frontmatter)"}: ${i.message}`);
      throw new Error(`invalid agent file ${sourcePath}: ${issues.join("; ")}`);
    }
    const fm = parsed.data;
    const id = fm.id ?? file.replace(/\.md$/, "");
    if (agents.has(id)) throw new Error(`Duplicate agent id "${id}" in ${sourcePath}`);

    const agent: AgentDefinition = {
      id,
      source,
      name: fm.name ?? id,
      description: fm.description,
      permissionMode: fm.permission_mode,
      systemPrompt: body.trim(),
      sourcePath,
    };
    if (fm.model !== undefined) agent.model = fm.model;
    if (fm.allowed_tools !== undefined) agent.allowedTools = fm.allowed_tools;
    if (fm.disallowed_tools !== undefined) agent.disallowedTools = fm.disallowed_tools;
    if (fm.effort !== undefined) agent.effort = fm.effort;
    if (fm.timeout_minutes !== undefined) agent.timeoutMinutes = fm.timeout_minutes;
    if (fm.max_budget_usd !== undefined) agent.maxBudgetUsd = fm.max_budget_usd;
    if (fm.wrap_up_reserve_usd !== undefined) agent.wrapUpReserveUsd = fm.wrap_up_reserve_usd;
    if (fm.inherit_mcp !== undefined) agent.inheritMcp = fm.inherit_mcp;
    if (fm.add_dirs !== undefined) agent.addDirs = fm.add_dirs.map(expandHome);
    if (fm.claude_agent !== undefined) agent.claudeAgent = fm.claude_agent;
    if (fm.project !== undefined) agent.project = fm.project;
    if (fm.max_concurrent !== undefined) agent.maxConcurrent = fm.max_concurrent;
    if (fm.isolated !== undefined) agent.isolated = fm.isolated;
    agents.set(id, agent);
  }
  return agents;
}

function loadProjects(file: string, configDir: string): Map<string, ProjectDefinition> {
  const projects = new Map<string, ProjectDefinition>();
  if (!existsSync(file)) return projects;
  const parsed = projectsSchema.parse(parseYaml(readFileSync(file, "utf8")) ?? {});
  for (const [id, p] of Object.entries(parsed.projects)) {
    // Relative paths resolve from the config/ directory, like data_dir.
    const def: ProjectDefinition = { id, path: path.resolve(configDir, expandHome(p.path)) };
    if (p.description !== undefined) def.description = p.description;
    if (p.inherit_mcp !== undefined) def.inheritMcp = p.inherit_mcp;
    if (p.add_dirs !== undefined) def.addDirs = p.add_dirs.map((d) => path.resolve(configDir, expandHome(d)));
    projects.set(id, def);
  }
  return projects;
}

export function splitFrontmatter(content: string): { frontmatter: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  return { frontmatter: parseYaml(match[1] ?? "") ?? {}, body: match[2] ?? "" };
}

/** True when `p` is an existing directory. */
export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
