import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_MAX_EVENT_BYTES, DEFAULT_MAX_LOG_BYTES } from "../execution/log-caps.js";
import { DEFAULT_NOOP_PATTERN, parseNoopPattern } from "../scheduler/idle.js";
import { logger } from "../util/log.js";
import {
  AGENT_ID_PATTERN,
  BOTH_PROJECT_AGENT_FIELDS,
  envPassthroughSchema,
  harnessNameSchema,
  maxConcurrentSchema,
  maxDailyCostUsdSchema,
  maxDailyRunsSchema,
  sandboxAllowedDomainsSchema,
  skillsSchema,
  timeoutMinutesSchema,
} from "./agent-files.js";
import { dataDirFromEnv, type LocationContext, userConfigDir, userDataDir } from "./locations.js";
import {
  type AgentDefinition,
  type AgentSource,
  type DataSource,
  type DuskFleetConfig,
  EFFORT_LEVELS,
  ON_FAILURE_POLICIES,
  PERMISSION_MODES,
  type ProjectDefinition,
  type SkippedAgentFile,
} from "./types.js";

const log = logger("config");

/**
 * No config to load: no config/duskfleet.yaml above the entry point, or none in the directory
 * DUSKFLEET_CONFIG names. Callers tell it apart with `instanceof` (the CLI points at `init`).
 */
export class ConfigNotFoundError extends Error {
  override name = "ConfigNotFoundError";
}

/** Where the config directory came from: DUSKFLEET_CONFIG, a repo-local config/, or the user-level one. */
export type ConfigSource = "env" | "repo" | "user";

export interface ConfigLocation {
  configDir: string;
  source: ConfigSource;
  /** Every candidate in precedence order, null when it does not apply (what `doctor` prints). */
  lookup: { env: string | null; repo: string | null; user: string };
}

/**
 * Locates the config directory, first match wins:
 *   1. DUSKFLEET_CONFIG env var (path to a directory containing duskfleet.yaml)
 *   2. <repo root>/config, where the repo root is the closest ancestor of
 *      `startFrom` (a file URL or a path) that contains config/duskfleet.yaml
 *   3. the user-level config directory (`userConfigDir`), whether or not it exists yet:
 *      `loadConfig` then throws ConfigNotFoundError until `initUserConfig` has written it.
 */
export function locateConfig(startFrom: string = process.cwd(), ctx: LocationContext = {}): ConfigLocation {
  const env = ctx.env ?? process.env;
  const fromEnv = env["DUSKFLEET_CONFIG"] ? expandHome(env["DUSKFLEET_CONFIG"]) : null;
  const root = findRepoRoot(startFrom);
  const repo = root ? path.join(root, "config") : null;
  const user = userConfigDir(ctx);
  const lookup = { env: fromEnv, repo, user };
  if (fromEnv) return { configDir: fromEnv, source: "env", lookup };
  if (repo) return { configDir: repo, source: "repo", lookup };
  return { configDir: user, source: "user", lookup };
}

/** `locateConfig(...).configDir`. */
export function resolveConfigDir(startFrom: string = process.cwd()): string {
  return locateConfig(startFrom).configDir;
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
  // null = the default: ../data next to a repo-local or DUSKFLEET_CONFIG config, the user-level
  // data directory next to the user-level config (see dataDirFor).
  data_dir: z.string().nullable().default(null),
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
      default_timeout_minutes: timeoutMinutesSchema("claude.default_timeout_minutes").default(30),
      default_max_budget_usd: z.number().positive().default(5),
      env_passthrough: envPassthroughSchema.default([]),
      max_event_bytes: z.number().int().min(1024).default(DEFAULT_MAX_EVENT_BYTES),
      max_log_bytes: z.number().int().min(1024).default(DEFAULT_MAX_LOG_BYTES),
    })
    .prefault({}),
  copilot: z
    .object({
      binary: z.string().nullable().default(null),
    })
    .prefault({}),
  codex: z
    .object({
      binary: z.string().nullable().default(null),
    })
    .prefault({}),
  cursor: z
    .object({
      binary: z.string().nullable().default(null),
    })
    .prefault({}),
  scheduler: z
    .object({
      enabled: z.boolean().default(true),
      tick_seconds: z.number().int().min(5).max(300).default(30),
      default_time_zone: z.string().default("Europe/London"),
      // A bad marker only feeds the idle-cost stats: warn and use the default rather than
      // failing every config reload (every run, list_* call and scheduler tick).
      noop_pattern: z
        .string()
        .default(DEFAULT_NOOP_PATTERN)
        .transform((p) => {
          try {
            parseNoopPattern(p);
            return p;
          } catch (err) {
            log.warn("scheduler.noop_pattern ignored, using the default", {
              err: err instanceof Error ? err.message : String(err),
              default: DEFAULT_NOOP_PATTERN,
            });
            return DEFAULT_NOOP_PATTERN;
          }
        }),
      auto_pause: z.boolean().default(true),
      auto_pause_after: z.number().int().min(0).default(5),
      allow_command_gates: z.boolean().default(false),
      defer_busy: z.boolean().default(true),
    })
    .prefault({}),
});

const agentFrontmatterSchema = z
  .object({
    id: z.string().regex(AGENT_ID_PATTERN, "agent id must be lowercase letters, digits, - or _").optional(),
    name: z.string().optional(),
    description: z.string().default(""),
    model: z.string().optional(),
    permission_mode: z.enum(PERMISSION_MODES).default("acceptEdits"),
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
    timeout_minutes: timeoutMinutesSchema("timeout_minutes").optional(),
    max_budget_usd: z.number().positive().optional(),
    wrap_up_reserve_usd: z.number().nonnegative().optional(),
    on_failure: z.enum(ON_FAILURE_POLICIES).optional(),
    resume_budget_usd: z.number().positive().optional(),
    inherit_mcp: z.boolean().optional(),
    add_dirs: z.array(z.string()).optional(),
    // The link field (issue #466): `project_agent`, or its older name `claude_agent`; never both.
    project_agent: z.string().min(1).optional(),
    claude_agent: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    max_concurrent: maxConcurrentSchema.optional(),
    isolated: z.boolean().optional(),
    max_daily_runs: maxDailyRunsSchema.optional(),
    max_daily_cost_usd: maxDailyCostUsdSchema.optional(),
    env_passthrough: envPassthroughSchema.optional(),
    // Names only; whether they exist is checked on create / update, never on load (a deleted skill
    // must not break every config reload) and skipped with a note at run start.
    skills: skillsSchema.optional(),
    sandbox: z.boolean().optional(),
    sandbox_allowed_domains: sandboxAllowedDomainsSchema.optional(),
    sandbox_weaker_network_isolation: z.boolean().optional(),
    codex_network: z.boolean().optional(),
    // A name only; whether a harness of that name is registered is checked on create / update and at
    // run start, never on load (the loader does not know the executors).
    harness: harnessNameSchema.optional(),
  })
  .refine((fm) => fm.project_agent === undefined || fm.claude_agent === undefined, {
    message: BOTH_PROJECT_AGENT_FIELDS,
    path: ["project_agent"],
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
    throw new ConfigNotFoundError(`Config file not found: ${globalPath}`);
  }
  const raw = parseYaml(readFileSync(globalPath, "utf8")) ?? {};
  const g = globalSchema.parse(raw);

  const { dataDir, dataSource } = dataDirFor(configDir, g.data_dir);
  const allowedProjectRoots = g.allowed_project_roots.map((r) => path.resolve(configDir, expandHome(r)));

  const userAgentsDir = g.user_agents_dir
    ? path.resolve(configDir, expandHome(g.user_agents_dir))
    : path.join(dataDir, "agents");

  // Builtin agents ship with the repo; user agents are created at runtime and
  // override a builtin with the same id. A file that does not load is skipped, never fatal: one
  // hand-edited agent must not stop every run, list and tick (#462).
  const builtin = loadAgentDir(path.join(configDir, "agents"), "builtin");
  const user = loadAgentDir(userAgentsDir, "user");
  const agents = builtin.agents;
  const skippedAgents: SkippedAgentFile[] = [...builtin.skipped, ...user.skipped];
  for (const [id, agent] of user.agents) agents.set(id, agent);
  // Fail closed: a broken user file takes its id out, it never falls back to the builtin it
  // overrides. A duplicate is the exception: the first file of that id is valid and stays.
  for (const s of user.skipped) {
    if (!user.duplicates.has(s.sourcePath) && !user.agents.has(s.id)) agents.delete(s.id);
  }
  // Projects: the versioned registry plus a private one next to the data (machine-specific
  // absolute paths never belong in the repo). Same id = the private entry wins.
  const projects = loadProjects(path.join(configDir, "projects.yaml"), configDir);
  const userProjectsFile = g.user_projects_file
    ? path.resolve(configDir, expandHome(g.user_projects_file))
    : path.join(dataDir, "projects.yaml");
  for (const [id, p] of loadProjects(userProjectsFile, path.dirname(userProjectsFile))) projects.set(id, p);

  for (const a of [...agents.values()]) {
    if (a.project && !projects.has(a.project)) {
      agents.delete(a.id);
      skippedAgents.push({
        sourcePath: a.sourcePath,
        source: a.source,
        id: a.id,
        error: `project "${a.project}" is not in projects.yaml (agent "${a.id}" belongs to it). Known projects: ${[...projects.keys()].join(", ") || "(none)"}`,
      });
    }
  }
  // A default_agent whose file was skipped loads: the run without agent_id fails naming the file.
  if (
    g.default_agent !== null &&
    !agents.has(g.default_agent) &&
    !skippedAgents.some((s) => s.id === g.default_agent)
  ) {
    throw new Error(
      `default_agent "${g.default_agent}" not found. Known agents: ${[...agents.keys()].join(", ") || "(none)"}`,
    );
  }

  return {
    configDir,
    dataDir,
    dataSource,
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
      envPassthrough: g.claude.env_passthrough,
      maxEventBytes: g.claude.max_event_bytes,
      maxLogBytes: g.claude.max_log_bytes,
    },
    copilot: {
      binary: g.copilot.binary ? expandHome(g.copilot.binary) : null,
    },
    codex: {
      binary: g.codex.binary ? expandHome(g.codex.binary) : null,
    },
    cursor: {
      binary: g.cursor.binary ? expandHome(g.cursor.binary) : null,
    },
    scheduler: {
      enabled: g.scheduler.enabled,
      tickSeconds: g.scheduler.tick_seconds,
      defaultTimeZone: g.scheduler.default_time_zone,
      noopPattern: g.scheduler.noop_pattern,
      autoPause: g.scheduler.auto_pause,
      autoPauseAfter: g.scheduler.auto_pause_after,
      allowCommandGates: g.scheduler.allow_command_gates,
      deferBusy: g.scheduler.defer_busy,
    },
    agents,
    projects,
    skippedAgents,
  };
}

/**
 * Why an agent id is unavailable because its file was skipped, naming the file: null when no
 * skipped file declares that id. Callers use it before their own "unknown agent" message.
 */
export function skippedAgentError(config: Pick<DuskFleetConfig, "skippedAgents">, id: string): string | null {
  const s = config.skippedAgents?.find((f) => f.id === id);
  return s ? `agent "${id}" is unavailable: its file ${s.sourcePath} does not load (${s.error})` : null;
}

/**
 * The data directory, first match wins: DUSKFLEET_DATA, `data_dir` in duskfleet.yaml (relative to
 * the config directory), then the default: the user-level data directory when `configDir` is the
 * user-level config directory, else ../data next to it (a clone's data/).
 */
export function dataDirFor(
  configDir: string,
  dataDirSetting: string | null,
  ctx: LocationContext = {},
): { dataDir: string; dataSource: DataSource } {
  const fromEnv = dataDirFromEnv(ctx.env);
  if (fromEnv) return { dataDir: fromEnv, dataSource: "env" };
  if (dataDirSetting !== null) {
    return { dataDir: path.resolve(configDir, expandHome(dataDirSetting)), dataSource: "config" };
  }
  if (path.resolve(configDir) === path.resolve(userConfigDir(ctx))) {
    return { dataDir: userDataDir(ctx), dataSource: "user" };
  }
  return { dataDir: path.resolve(configDir, "../data"), dataSource: "config" };
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
  const { agents, skipped } = loadAgentDir(agentsDir, source);
  if (skipped[0]) throw new Error(skipped[0].error);
  return agents;
}

/**
 * The lenient form `loadConfig` uses: every file that loads, plus one entry per file that does
 * not (unreadable YAML, frontmatter schema, an id already taken in this directory; `duplicates`
 * holds the paths of the last kind, whose id belongs to an earlier valid file).
 */
export function loadAgentDir(
  agentsDir: string,
  source: AgentSource,
): { agents: Map<string, AgentDefinition>; skipped: SkippedAgentFile[]; duplicates: Set<string> } {
  const agents = new Map<string, AgentDefinition>();
  const skipped: SkippedAgentFile[] = [];
  const duplicates = new Set<string>();
  if (!existsSync(agentsDir)) return { agents, skipped, duplicates };

  for (const file of readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const sourcePath = path.join(agentsDir, file);
    const fileId = file.replace(/\.md$/, "");
    let frontmatter: unknown;
    let body: string;
    let raw = "";
    try {
      raw = readFileSync(sourcePath, "utf8");
      ({ frontmatter, body } = splitFrontmatter(raw));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({
        sourcePath,
        source,
        id: guessAgentId(raw) ?? fileId,
        error: `invalid agent file ${sourcePath}: ${message}`,
      });
      continue;
    }
    const parsed = agentFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(frontmatter)"}: ${i.message}`);
      const declared = (frontmatter as { id?: unknown } | null)?.id;
      skipped.push({
        sourcePath,
        source,
        id: typeof declared === "string" && declared ? declared : (guessAgentId(raw) ?? fileId),
        error: `invalid agent file ${sourcePath}: ${issues.join("; ")}`,
      });
      continue;
    }
    const fm = parsed.data;
    const id = fm.id ?? fileId;
    if (agents.has(id)) {
      skipped.push({ sourcePath, source, id, error: `Duplicate agent id "${id}" in ${sourcePath}` });
      duplicates.add(sourcePath);
      continue;
    }

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
    if (fm.on_failure !== undefined) agent.onFailure = fm.on_failure;
    if (fm.resume_budget_usd !== undefined) agent.resumeBudgetUsd = fm.resume_budget_usd;
    if (fm.inherit_mcp !== undefined) agent.inheritMcp = fm.inherit_mcp;
    if (fm.add_dirs !== undefined) agent.addDirs = fm.add_dirs.map(expandHome);
    // Either name loads into the same field: same definition, same agent_hash.
    const projectAgent = fm.project_agent ?? fm.claude_agent;
    if (projectAgent !== undefined) agent.claudeAgent = projectAgent;
    if (fm.project !== undefined) agent.project = fm.project;
    if (fm.max_concurrent !== undefined) agent.maxConcurrent = fm.max_concurrent;
    if (fm.isolated !== undefined) agent.isolated = fm.isolated;
    if (fm.max_daily_runs !== undefined) agent.maxDailyRuns = fm.max_daily_runs;
    if (fm.max_daily_cost_usd !== undefined) agent.maxDailyCostUsd = fm.max_daily_cost_usd;
    if (fm.env_passthrough !== undefined) agent.envPassthrough = fm.env_passthrough;
    if (fm.skills !== undefined) agent.skills = fm.skills;
    if (fm.sandbox !== undefined) agent.sandbox = fm.sandbox;
    if (fm.sandbox_allowed_domains !== undefined) agent.sandboxAllowedDomains = fm.sandbox_allowed_domains;
    if (fm.sandbox_weaker_network_isolation !== undefined)
      agent.sandboxWeakerNetworkIsolation = fm.sandbox_weaker_network_isolation;
    if (fm.codex_network !== undefined) agent.codexNetwork = fm.codex_network;
    if (fm.harness !== undefined) agent.harness = fm.harness;
    agents.set(id, agent);
  }
  return { agents, skipped, duplicates };
}

/**
 * Best-effort id of an agent file whose frontmatter does not parse (#462): the first top-level
 * `id:` line of the frontmatter block, when it is a plain agent id. A guess, so a broken file that
 * declares another id than its file name still takes that id out instead of leaving a builtin served.
 */
export function guessAgentId(raw: string): string | null {
  const block = /^---\r?\n([\s\S]*?)(?:\r?\n---|$)/.exec(raw)?.[1];
  if (!block) return null;
  const m = /^id:[ \t]*(["']?)([a-z0-9][a-z0-9_-]*)\1[ \t]*(?:#.*)?$/m.exec(block);
  return m?.[2] ?? null;
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
