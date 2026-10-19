/**
 * Server-only data access for the dashboard. Reads the same config/ and
 * data/duskfleet.db the MCP server uses. The dashboard never mutates runs;
 * cancelling goes through the MCP server (cancel_run) or the CLI. Its writes
 * are server actions on user agent files (app/agents/actions.ts) and on
 * schedule rows (app/schedules/actions.ts), both on the core API.
 */
import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  budgetPlan,
  type DuskFleetConfig,
  describeCron,
  findRepoRoot,
  listProjectAgents,
  loadConfig,
  NEEDS_REVIEW_SQL,
  nextFire,
  openDatabase,
  type ProjectAgentInfo,
  parseCron,
  type Run,
  RunRepository,
  type RunStatus,
  resolveClaudeBinary,
  resolveConfigDir,
  ScheduleRepository,
  scheduleIdleStats,
  scheduleRunState,
} from "@duskfleet/core";

interface Services {
  configDir: string;
  db: DatabaseSync;
  runs: RunRepository;
  schedules: ScheduleRepository;
}

// One DB handle per process (cached across hot reloads in dev).
const g = globalThis as unknown as { __duskfleet_v3?: Services };

export function services(): Services {
  if (!g.__duskfleet_v3) {
    const configDir = resolveConfigDir(process.cwd());
    const config = loadConfig(configDir);
    const db = openDatabase(config.dataDir);
    g.__duskfleet_v3 = { configDir, db, runs: new RunRepository(db), schedules: new ScheduleRepository(db) };
  }
  return g.__duskfleet_v3;
}

/** Config is re-read on every request so edits under config/ show up immediately. */
export function config(): DuskFleetConfig {
  return loadConfig(services().configDir);
}

/**
 * What a linked agent (`claude_agent`) adopts from the project's own
 * `.claude/agents/<name>.md`. `found: false` means the link points at a name
 * the project does not define, which `run_agent` would refuse.
 */
export interface LinkedAgentInfo {
  name: string;
  found: boolean;
  model: string | null;
  path: string | null;
  /** The project agent's own frontmatter description (what `claude --agent` actually runs as). */
  description: string | null;
}

function resolveLink(
  cfg: DuskFleetConfig,
  cache: Map<string, ProjectAgentInfo[]>,
  projectId: string | undefined,
  name: string,
): LinkedAgentInfo {
  const project = projectId ? cfg.projects.get(projectId) : undefined;
  if (!project) return { name, found: false, model: null, path: null, description: null };
  let list = cache.get(project.id);
  if (!list) {
    try {
      list = listProjectAgents(project.path);
    } catch {
      list = [];
    }
    cache.set(project.id, list);
  }
  const hit = list.find((p) => p.name === name);
  return hit
    ? { name, found: true, model: hit.model, path: hit.path, description: hit.description || null }
    : { name, found: false, model: null, path: null, description: null };
}

/**
 * One agent as defined now, for the run page. Resolves only its own link, so a
 * live run refreshing every 3 s does not read every linked project's agents.
 * `description` joins the agent's and the linked agent's, without repeating one.
 */
export function agentSummary(
  id: string,
): { id: string; name: string; claudeAgent: string | null; description: string } | null {
  const cfg = config();
  const a = cfg.agents.get(id);
  if (!a) return null;
  const linked = a.claudeAgent ? resolveLink(cfg, new Map(), a.project, a.claudeAgent) : null;
  const parts = [a.description, linked?.description].filter((d): d is string => Boolean(d));
  return { id: a.id, name: a.name, claudeAgent: a.claudeAgent ?? null, description: [...new Set(parts)].join(" · ") };
}

export function listAgents() {
  const cfg = config();
  // .claude/agents is read once per project per request, not once per agent.
  const projectAgents = new Map<string, ProjectAgentInfo[]>();

  return [...cfg.agents.values()].map(({ systemPrompt, ...a }) => {
    const linked = a.claudeAgent ? resolveLink(cfg, projectAgents, a.project, a.claudeAgent) : null;
    // What a run actually starts with: this file's model overrides, otherwise
    // the project agent's own model, otherwise the Claude Code default.
    const effectiveModel = a.model ?? linked?.model ?? null;
    const modelSource: "agent" | "link" | "default" = a.model ? "agent" : linked?.model ? "link" : "default";
    return {
      ...a,
      systemPromptPreview: systemPrompt.length > 400 ? systemPrompt.slice(0, 397) + "..." : systemPrompt,
      systemPromptLength: systemPrompt.length,
      timeoutMinutes: a.timeoutMinutes ?? cfg.claude.defaultTimeoutMinutes,
      maxBudgetUsd: a.maxBudgetUsd ?? cfg.claude.defaultMaxBudgetUsd,
      /** Dollars of the budget held back for the wrap-up pass after a budget exhaustion (0 = disabled). */
      wrapUpReserveUsd: budgetPlan(a, cfg).reserve,
      maxConcurrent: a.maxConcurrent ?? cfg.maxConcurrentPerAgent,
      maxConcurrentIsDefault: (a.maxConcurrent ?? cfg.maxConcurrentPerAgent) === cfg.maxConcurrentPerAgent,
      isDefault: a.id === cfg.defaultAgent,
      linked,
      effectiveModel,
      modelSource,
    };
  });
}

export interface RunsFilter {
  status?: RunStatus;
  agentId?: string;
  projectPath?: string;
  /** Only runs started by this schedule (filtered in memory: no index needed for a few hundred rows). */
  scheduleId?: string;
  /** Case-insensitive substring of the prompt (in memory). */
  q?: string;
  limit?: number;
}

/** A run plus the label the UI shows for its project (registry id when known, else the folder name) and its linked retry, if any. */
export type RunWithProject = Run & { projectLabel: string; resumedByRunId: string | null };

/**
 * Older runs were recorded without `projectId` even when the path is a registered
 * project, which made the same folder show up under two labels. Resolve by path.
 */
function projectLabeller(): (run: Run) => string {
  const byPath = new Map<string, string>();
  for (const p of config().projects.values()) byPath.set(p.path.replace(/\/+$/, ""), p.id);
  return (run) =>
    run.projectId ??
    byPath.get(run.projectPath.replace(/\/+$/, "")) ??
    run.projectPath.split("/").filter(Boolean).pop() ??
    run.projectPath;
}

export function listRuns(filter: RunsFilter = {}): RunWithProject[] {
  const { runs } = services();
  const inMemory = Boolean(filter.scheduleId || filter.q);
  const limit = filter.limit ?? 50;
  const f: { status?: RunStatus; agentId?: string; projectPath?: string; limit: number } = {
    limit: inMemory ? 200 : limit,
  };
  if (filter.status) f.status = filter.status;
  if (filter.agentId) f.agentId = filter.agentId;
  if (filter.projectPath) f.projectPath = filter.projectPath;
  let list = runs.list(f);
  if (filter.scheduleId) list = list.filter((r) => r.scheduleId === filter.scheduleId);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    list = list.filter((r) => r.prompt.toLowerCase().includes(q) || r.id.startsWith(q));
  }
  if (inMemory) list = list.slice(0, limit);
  const label = projectLabeller();
  const resumedBy = runs.resumedByMany(list.map((r) => r.id));
  return list.map((r) => ({ ...r, projectLabel: label(r), resumedByRunId: resumedBy.get(r.id) ?? null }));
}

/** Label for a single run (detail page). */
export function projectLabel(run: Run): string {
  return projectLabeller()(run);
}

/** The user's home directory, so pages can print `~/…` instead of the full path. */
export function homeDir(): string {
  return homedir();
}

/** Neighbours of a run among the same agent's runs, for Previous / Next navigation. */
export function adjacentRuns(run: Run): {
  prev: Pick<Run, "id" | "prompt" | "createdAt"> | null;
  next: Pick<Run, "id" | "prompt" | "createdAt"> | null;
} {
  const { db } = services();
  const pick = (sql: string) => {
    const r = db.prepare(sql).get(run.agentId, run.createdAt) as
      | { id: string; prompt: string; created_at: string }
      | undefined;
    return r ? { id: r.id, prompt: r.prompt, createdAt: r.created_at } : null;
  };
  return {
    prev: pick(
      "SELECT id, prompt, created_at FROM runs WHERE agent_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1",
    ),
    next: pick(
      "SELECT id, prompt, created_at FROM runs WHERE agent_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 1",
    ),
  };
}

export function listProjects() {
  return [...config().projects.values()];
}

export function getRun(id: string) {
  const { runs } = services();
  const run = runs.get(id);
  if (!run) return null;
  // Linked retry (on_failure: resume_once): the run this one resumed, and the one that resumed it.
  const resumedFrom = run.resumedFromRunId ? runs.get(run.resumedFromRunId) : null;
  const resumedBy = runs.resumedBy(id);
  return { run, events: runs.events(id), resumedFrom, resumedBy };
}

/** The run's JSONL log path, only when it resolves inside `<dataDir>/logs`; null otherwise. */
export function runLogPath(run: Run): string | null {
  if (!run.logPath) return null;
  const logsDir = path.resolve(config().dataDir, "logs");
  const resolved = path.resolve(run.logPath);
  return resolved.startsWith(`${logsDir}${path.sep}`) ? resolved : null;
}

export interface AgentStats {
  agentId: string;
  total: number;
  running: number;
  completed: number;
  failed: number;
  needsReview: number;
  costUsd: number;
  avgDurationMs: number | null;
  lastRunAt: string | null;
  /** model_used of the most recent run that reported one: what an alias like "sonnet" resolved to. */
  lastModelUsed: string | null;
}

export function agentStats(): AgentStats[] {
  const { db } = services();
  const rows = db
    .prepare(
      `SELECT agent_id,
              COUNT(*)                                          AS total,
              SUM(status = 'running')                           AS running,
              SUM(status = 'completed')                         AS completed,
              SUM(status IN ('failed','timed_out','cancelled')) AS failed,
              SUM(${NEEDS_REVIEW_SQL})                          AS needs_review,
              COALESCE(SUM(cost_usd), 0)                        AS cost_usd,
              AVG(duration_ms)                                  AS avg_duration_ms,
              MAX(created_at)                                   AS last_run_at,
              (SELECT model_used FROM runs r2 WHERE r2.agent_id = runs.agent_id AND r2.model_used IS NOT NULL
                 ORDER BY r2.created_at DESC LIMIT 1)          AS last_model_used
       FROM runs GROUP BY agent_id ORDER BY total DESC`,
    )
    .all() as Array<{
    agent_id: string;
    total: number;
    running: number;
    completed: number;
    failed: number;
    needs_review: number;
    cost_usd: number;
    avg_duration_ms: number | null;
    last_run_at: string | null;
    last_model_used: string | null;
  }>;
  return rows.map((r) => ({
    agentId: r.agent_id,
    total: r.total,
    running: r.running,
    completed: r.completed,
    failed: r.failed,
    needsReview: r.needs_review,
    costUsd: r.cost_usd,
    avgDurationMs: r.avg_duration_ms,
    lastRunAt: r.last_run_at,
    lastModelUsed: r.last_model_used,
  }));
}

export interface ModelStats {
  model: string;
  runs: number;
  avgDurationMs: number | null;
  avgCostUsd: number | null;
  costUsd: number;
}

/** Cost and speed per model actually used, for the overview breakdown. */
export function modelStats(): ModelStats[] {
  const { db } = services();
  const rows = db
    .prepare(
      `SELECT COALESCE(model_used, model_requested, 'default') AS model,
              COUNT(*)                 AS runs,
              AVG(duration_ms)         AS avg_duration_ms,
              AVG(cost_usd)            AS avg_cost_usd,
              COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM runs
       WHERE status IN ('completed','failed','timed_out','cancelled')
       GROUP BY 1 ORDER BY cost_usd DESC`,
    )
    .all() as Array<{
    model: string;
    runs: number;
    avg_duration_ms: number | null;
    avg_cost_usd: number | null;
    cost_usd: number;
  }>;
  return rows.map((r) => ({
    model: r.model,
    runs: r.runs,
    avgDurationMs: r.avg_duration_ms,
    avgCostUsd: r.avg_cost_usd,
    costUsd: r.cost_usd,
  }));
}

/** Every count is real runs (kind 'run'); gate runs only show in the cost (costGatesUsd). */
export interface Overview {
  total: number;
  running: number;
  finished: number;
  completed: number;
  /** Completed without a review reason: the number that deserves to be green. */
  clean: number;
  /** failed, timed out or cancelled. */
  failed: number;
  /** Every run with a review reason, completed or not (a failed run is counted here too). */
  needsReview: number;
  costUsd: number;
  costLast24hUsd: number;
  /** Part of costUsd spent by schedule gate agents (runs of kind 'gate'). */
  costGatesUsd: number;
}

/** KPIs for the cards. With a filter, computed on the same subset the list shows. */
export function overview(filter: Pick<RunsFilter, "agentId" | "projectPath"> = {}): Overview {
  const { db } = services();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const where: string[] = [];
  const values: string[] = [since];
  if (filter.agentId) {
    where.push("agent_id = ?");
    values.push(filter.agentId);
  }
  if (filter.projectPath) {
    where.push("project_path = ?");
    values.push(filter.projectPath);
  }
  const r = db
    .prepare(
      // Counts are real runs only: a gate run is a schedule's yes/no check, and one that ends
      // budget_exhausted or with a denial must not raise the failed / needs-review KPIs. Its
      // cost is part of the spend, shown apart (cost_gates).
      `SELECT COALESCE(SUM(kind = 'run'), 0)                                     AS total,
              SUM(kind = 'run' AND status = 'running')                            AS running,
              SUM(kind = 'run' AND status IN ('completed','failed','timed_out','cancelled')) AS finished,
              SUM(kind = 'run' AND status = 'completed')                          AS completed,
              SUM(kind = 'run' AND status = 'completed' AND NOT ${NEEDS_REVIEW_SQL}) AS clean,
              SUM(kind = 'run' AND status IN ('failed','timed_out','cancelled'))  AS failed,
              SUM(kind = 'run' AND ${NEEDS_REVIEW_SQL})                           AS needs_review,
              COALESCE(SUM(cost_usd), 0)                                          AS cost_usd,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN cost_usd END), 0)       AS cost_24h,
              COALESCE(SUM(CASE WHEN kind = 'gate' THEN cost_usd END), 0)         AS cost_gates
       FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
    )
    .get(...values) as {
    total: number;
    running: number | null;
    finished: number | null;
    completed: number | null;
    clean: number | null;
    failed: number | null;
    needs_review: number | null;
    cost_usd: number;
    cost_24h: number;
    cost_gates: number;
  };
  return {
    total: r.total,
    running: r.running ?? 0,
    finished: r.finished ?? 0,
    completed: r.completed ?? 0,
    clean: r.clean ?? 0,
    failed: r.failed ?? 0,
    needsReview: r.needs_review ?? 0,
    costUsd: r.cost_usd,
    costLast24hUsd: r.cost_24h,
    costGatesUsd: r.cost_gates,
  };
}

export function listSchedules() {
  const { schedules, runs } = services();
  const cfg = config();
  const now = new Date();
  return schedules.list().map((s) => {
    let cronHuman = s.cron;
    let theoreticalNextAt: string | null = null;
    try {
      const spec = parseCron(s.cron);
      cronHuman = describeCron(spec);
      theoreticalNextAt = nextFire(spec, now, s.timeZone)?.toISOString() ?? null;
    } catch {
      // keep raw
    }
    // How the run it last started ended (the tick outcome alone hides a failed run) and what the
    // next fire does: the same core composition as list_schedules and the CLI.
    const { lastRun, effectiveOnFailure, onFailureSource, willResumeRunId } = scheduleRunState(
      s,
      cfg.agents.get(s.agentId),
      runs,
    );
    const idle7d = scheduleIdleStats(schedules, s, cfg.scheduler.noopPattern, now);
    return {
      ...s,
      cronHuman,
      theoreticalNextAt,
      lastRun,
      effectiveOnFailure,
      onFailureSource,
      willResumeRunId,
      idle7d,
    };
  });
}

export function scheduleFirings(id: string, limit = 10) {
  return services().schedules.firings(id, limit);
}

export function schedulerLease() {
  return services().schedules.leaseInfo();
}

export function schedulerEnabled(): boolean {
  return config().scheduler.enabled;
}

export interface ToolCatalogEntry {
  name: string;
  title: string | null;
  description: string;
  inputSchema: { type?: string; properties?: Record<string, JsonSchema>; required?: string[] } | null;
  group: "runs" | "agents" | "schedules" | "projects" | "other";
}
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
}
export interface ToolCatalog {
  generatedAt: string;
  server: { name: string; version: string; instructions: string };
  tools: ToolCatalogEntry[];
  path: string;
}

/**
 * The MCP tool catalogue is written by `npm run build` of @duskfleet/mcp
 * (packages/mcp/dist/tools.json). The dashboard only reads the file: it must
 * not depend on the mcp package.
 */
export function toolCatalog(): ToolCatalog | null {
  const root = findRepoRoot(process.cwd());
  if (!root) return null;
  const file = path.join(root, "packages", "mcp", "dist", "tools.json");
  if (!existsSync(file)) return null;
  try {
    return { ...(JSON.parse(readFileSync(file, "utf8")) as Omit<ToolCatalog, "path">), path: file };
  } catch {
    return null;
  }
}

/** Where this server is registered, for the docs page. Absolute paths, as the hosts need them. */
export function mcpRegistration() {
  const root = findRepoRoot(process.cwd());
  const entry = root ? path.join(root, "packages", "mcp", "dist", "index.js") : "<repo>/packages/mcp/dist/index.js";
  let claudeBin: string;
  try {
    claudeBin = resolveClaudeBinary(config().claude.binary); // absolute: GUI hosts start with a minimal PATH
  } catch {
    claudeBin = "/absolute/path/to/claude";
  }
  return { entry, node: process.execPath, claudeBin };
}

/** The Claude Code agents a registered project defines in its own .claude/agents/ (subagents and link targets). */
export function projectAgentsFor(projectId: string): ProjectAgentInfo[] {
  const p = config().projects.get(projectId);
  if (!p) return [];
  try {
    return listProjectAgents(p.path);
  } catch {
    return [];
  }
}
