/**
 * Reading and writing agent definition files.
 *
 * Agents are Markdown files with YAML frontmatter, the same format Claude Code
 * uses for its own agents. They live in two places:
 *
 *   - config/agents/      "builtin": versioned with the repo (examples, defaults)
 *   - <user_agents_dir>/  "user":    created at runtime (MCP tools, by hand);
 *                                    defaults to <data_dir>/agents, git-ignored
 *
 * A user agent with the same id as a builtin one overrides it. Only the user
 * directory is ever written by code; the repo stays untouched.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { type AgentDefinition, EFFORT_LEVELS, PERMISSION_MODES } from "./types.js";

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/** Everything an agent file can contain, flattened (frontmatter + body). */
export const agentSpecSchema = z.object({
  id: z.string().regex(AGENT_ID_PATTERN, "agent id must be lowercase letters, digits, - or _"),
  name: z.string().min(1).optional(),
  description: z.string().default(""),
  model: z.string().min(1).optional(),
  permission_mode: z.enum(PERMISSION_MODES).default("acceptEdits"),
  allowed_tools: z.array(z.string().min(1)).optional(),
  disallowed_tools: z.array(z.string().min(1)).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  timeout_minutes: z.number().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  wrap_up_reserve_usd: z.number().nonnegative().optional(),
  inherit_mcp: z.boolean().optional(),
  add_dirs: z.array(z.string().min(1)).optional(),
  claude_agent: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  system_prompt: z.string().default(""),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;

export function agentFilePath(dir: string, id: string): string {
  if (!AGENT_ID_PATTERN.test(id)) throw new Error(`invalid agent id "${id}"`);
  return path.join(dir, `${id}.md`);
}

/** Serialises a spec to the Markdown + frontmatter format the loader reads. */
export function renderAgentMarkdown(spec: AgentSpec): string {
  const { system_prompt, ...frontmatter } = spec;
  const clean = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined));
  return `---\n${stringifyYaml(clean).trimEnd()}\n---\n${system_prompt.trim()}\n`;
}

/** Writes (creates or replaces) `<dir>/<id>.md`. Returns the file path. */
export function writeAgentFile(dir: string, spec: AgentSpec): string {
  const file = agentFilePath(dir, spec.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, renderAgentMarkdown(spec), "utf8");
  return file;
}

/** Removes `<dir>/<id>.md`. Returns false when it did not exist. */
export function deleteAgentFile(dir: string, id: string): boolean {
  const file = agentFilePath(dir, id);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/** Inverse of the loader: a loaded definition back to a writable spec (used by update_agent). */
export function agentToSpec(a: AgentDefinition): AgentSpec {
  const spec: AgentSpec = {
    id: a.id,
    name: a.name,
    description: a.description,
    permission_mode: a.permissionMode,
    system_prompt: a.systemPrompt,
  };
  if (a.model !== undefined) spec.model = a.model;
  if (a.allowedTools !== undefined) spec.allowed_tools = a.allowedTools;
  if (a.disallowedTools !== undefined) spec.disallowed_tools = a.disallowedTools;
  if (a.effort !== undefined) spec.effort = a.effort;
  if (a.timeoutMinutes !== undefined) spec.timeout_minutes = a.timeoutMinutes;
  if (a.maxBudgetUsd !== undefined) spec.max_budget_usd = a.maxBudgetUsd;
  if (a.wrapUpReserveUsd !== undefined) spec.wrap_up_reserve_usd = a.wrapUpReserveUsd;
  if (a.inheritMcp !== undefined) spec.inherit_mcp = a.inheritMcp;
  if (a.addDirs !== undefined) spec.add_dirs = a.addDirs;
  if (a.claudeAgent !== undefined) spec.claude_agent = a.claudeAgent;
  if (a.project !== undefined) spec.project = a.project;
  return spec;
}

/** A Claude Code agent defined by a project in `.claude/agents/<name>.md`. */
export interface ProjectAgentInfo {
  name: string;
  description: string;
  tools: string[] | null;
  model: string | null;
  path: string;
}

/**
 * Lists the agents a project defines for Claude Code. These are what
 * `claude --agent <name>` (AgentDefinition.claudeAgent) can adopt.
 */
export function listProjectAgents(projectPath: string): ProjectAgentInfo[] {
  const dir = path.join(projectPath, ".claude", "agents");
  if (!existsSync(dir)) return [];
  const out: ProjectAgentInfo[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const full = path.join(dir, file);
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(full, "utf8"));
    let fm: Record<string, unknown> = {};
    try {
      const parsed = match ? parseYaml(match[1] ?? "") : null;
      if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
    } catch {
      // unreadable frontmatter: still list the file by name
    }
    const name = typeof fm["name"] === "string" ? fm["name"] : file.replace(/\.md$/, "");
    const toolsRaw = fm["tools"];
    const tools = Array.isArray(toolsRaw)
      ? toolsRaw.map(String)
      : typeof toolsRaw === "string"
        ? toolsRaw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : null;
    out.push({
      name,
      description: typeof fm["description"] === "string" ? fm["description"] : "",
      tools,
      model: typeof fm["model"] === "string" ? fm["model"] : null,
      path: full,
    });
  }
  return out;
}

/**
 * Short content hash of `<project>/.claude/agents/<name>.md`, so a recorded subagent
 * invocation can be tied to the exact persona that ran. Null when the name is not a
 * project agent (builtins such as `claude` or `Explore`, or a name chosen in frontmatter).
 */
export function projectAgentDefinitionHash(projectPath: string, name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const file = path.join(projectPath, ".claude", "agents", `${name}.md`);
  if (!existsSync(file)) return null;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * The two kinds of DuskFleet agent. The distinction is explicit in the MCP
 * tools because mixing them up produces agents that look fine and do nothing:
 *
 *  - "own":  the persona is defined here (the Markdown body is the system prompt).
 *  - "link": the persona is an agent the target project already defines in
 *            `.claude/agents/<name>.md`; this file only adds the unattended
 *            envelope (permissions, allow-list, budget, MCP, extra instructions).
 */
export type AgentKind = "own" | "link";

export function agentKind(a: { claudeAgent?: string | undefined } | { claude_agent?: string | undefined }): AgentKind {
  const linked = "claudeAgent" in a ? a.claudeAgent : (a as { claude_agent?: string }).claude_agent;
  return linked ? "link" : "own";
}

/**
 * `wrap_up_reserve_usd` may take at most half of the budget (`max_budget_usd`, or the
 * config default when the agent sets none). The run would silently cap a larger value
 * (budgetPlan), so create/update reject it instead of reporting a different number.
 */
export function assertWrapUpReserve(
  spec: Pick<AgentSpec, "max_budget_usd" | "wrap_up_reserve_usd">,
  defaultMaxBudgetUsd: number,
): void {
  if (spec.wrap_up_reserve_usd === undefined) return;
  const total = spec.max_budget_usd ?? defaultMaxBudgetUsd;
  if (spec.wrap_up_reserve_usd > total / 2) {
    throw new Error(
      `wrap_up_reserve_usd (${spec.wrap_up_reserve_usd}) cannot exceed half of the budget (${spec.max_budget_usd !== undefined ? "max_budget_usd" : "default max budget"} ${total}, so at most ${Math.round((total / 2) * 100) / 100}). Lower it, raise max_budget_usd, or use 0 to disable the wrap-up pass.`,
    );
  }
}

/**
 * Checks that a spec is a well-formed agent of the declared kind:
 *  own  → system_prompt non-empty, no claude_agent
 *  link → claude_agent and project set, and the project really defines that agent
 */
export function assertAgentKind(
  kind: AgentKind,
  spec: AgentSpec,
  resolveProjectPath: (projectId: string) => string | null,
): void {
  if (kind === "own") {
    if (spec.claude_agent)
      throw new Error(
        `kind "own" cannot have claude_agent (that makes it a link). Use kind "link" or drop claude_agent.`,
      );
    if (!spec.system_prompt?.trim())
      throw new Error(
        `kind "own" needs a system_prompt: it is the agent's persona. Use kind "link" to reuse a project agent instead.`,
      );
    return;
  }
  if (!spec.claude_agent)
    throw new Error(
      `kind "link" needs claude_agent: the name of an agent in the project's .claude/agents/ (see list_project_agents).`,
    );
  if (!spec.project) {
    throw new Error(
      `kind "link" needs the folder that defines the agent: pass project_path (absolute path with .claude/agents/${spec.claude_agent}.md) or a registered project id.`,
    );
  }
  const projectPath = resolveProjectPath(spec.project);
  if (!projectPath) throw new Error(`unknown project "${spec.project}"`);
  const available = listProjectAgents(projectPath).map((a) => a.name);
  if (!available.includes(spec.claude_agent)) {
    throw new Error(
      `project "${spec.project}" defines no agent "${spec.claude_agent}" in .claude/agents/ (available: ${available.join(", ") || "none"}). Pick one from list_project_agents, or use kind "own".`,
    );
  }
}
