/**
 * Harnesses (issue #445): one run path, one adapter per agent CLI. A harness is an `Executor`
 * registered under a name (`claude`, later `codex`, `copilot`) that declares what it can honour
 * (`HarnessCapabilities`). An agent picks one with `harness:` in its frontmatter (default
 * `DEFAULT_HARNESS`).
 *
 * The rule is refuse, never approximate: an agent that sets a field its harness cannot honour is
 * refused at create / update and again at run start, with the field named. These agents run with
 * nobody watching; an allow-list an adapter silently dropped is a permission the owner never granted.
 */
import { type AgentSpec, agentToSpec } from "../config/agent-files.js";
import {
  type AgentDefinition,
  DEFAULT_HARNESS,
  PERMISSION_MODES,
  type PermissionMode,
  type ProjectDefinition,
} from "../config/types.js";
import { copilotRuleRefusal } from "./copilot-rules.js";
import type { Executor } from "./types.js";

/** What an adapter can honour. `false` (or a mode left out) makes the agent fields behind it refused. */
export interface HarnessCapabilities {
  /** `allowed_tools` / `disallowed_tools` are enforced by the CLI. */
  toolAllowList: boolean;
  /** `permission_mode` values it accepts. */
  permissionModes: readonly PermissionMode[];
  /** A session can be continued: `on_failure: resume_once`, `resume_budget_usd`, a continued run. */
  resumeSession: boolean;
  /** The CLI stops itself at `max_budget_usd` (and so a `wrap_up_reserve_usd` can be held back). */
  hardBudgetUsd: boolean;
  /**
   * The result carries a cost in dollars. Without it every run is `unpriced` (budgets count it as
   * its cap) and `max_daily_cost_usd`, which sums reported costs, is refused.
   */
  reportsCostUsd: boolean;
  /** Nested agents are reported (subagent rows). Informational: no agent field depends on it. */
  subagents: boolean;
  /** `inherit_mcp` (agent or project) gives the run the user's MCP connectors. */
  mcpInherit: boolean;
  /** `link` agents: `claude_agent`, a persona defined by the project itself. */
  projectAgents: boolean;
  /** `add_dirs` (agent or project). */
  addDirs: boolean;
  /** `skills:` (a bundle passed as one more directory). */
  skills: boolean;
  /** `effort`. */
  effort: boolean;
  /** `sandbox`, `sandbox_allowed_domains`, `sandbox_weaker_network_isolation`. */
  sandbox: boolean;
  /**
   * `permission_mode` values under which `codex_network: true` (network on, every host) is honoured
   * (issue #488). Absent or empty = the field is refused on this harness.
   */
  networkModes?: readonly PermissionMode[];
  /**
   * Why one `allowed_tools` / `disallowed_tools` entry is refused, or null when the CLI takes it
   * as written. Absent = every entry is accepted (Claude Code validates its own rules).
   */
  toolRule?: (rule: string) => string | null;
}

/** Capability names, in the order `doctor` and the docs list them. */
export const HARNESS_CAPABILITY_KEYS = [
  "toolAllowList",
  "permissionModes",
  "resumeSession",
  "hardBudgetUsd",
  "reportsCostUsd",
  "subagents",
  "mcpInherit",
  "projectAgents",
  "addDirs",
  "skills",
  "effort",
  "sandbox",
  "networkModes",
] as const satisfies readonly (keyof HarnessCapabilities)[];

/**
 * Claude Code honours every field (they were designed around it). `bypassPermissions` stays in the
 * list: the executor refuses it unless `claude.allow_bypass_permissions` is set, as before.
 */
export const CLAUDE_CAPABILITIES: HarnessCapabilities = Object.freeze({
  toolAllowList: true,
  permissionModes: PERMISSION_MODES,
  resumeSession: true,
  hardBudgetUsd: true,
  reportsCostUsd: true,
  subagents: true,
  mcpInherit: true,
  projectAgents: true,
  addDirs: true,
  skills: true,
  effort: true,
  sandbox: true,
});

/** Name of the GitHub Copilot CLI harness (issue #446). */
export const COPILOT_HARNESS = "copilot";

/**
 * GitHub Copilot CLI (1.0.112, docs/harnesses.md): its own tool rules (`toolRule`), deny by
 * default in a non-interactive run (`dontAsk`; `acceptEdits` adds `write`), resumable sessions, no
 * dollars (every run `unpriced`), none of the Claude-only fields. `addDirs` stays false: Copilot's
 * `--add-dir` also trusts that directory's skills and agents, not the same promise.
 */
export const COPILOT_CAPABILITIES: HarnessCapabilities = Object.freeze({
  toolAllowList: true,
  permissionModes: ["dontAsk", "acceptEdits"] as const,
  resumeSession: true,
  hardBudgetUsd: false,
  reportsCostUsd: false,
  subagents: false,
  mcpInherit: false,
  projectAgents: false,
  addDirs: false,
  skills: false,
  effort: true,
  sandbox: false,
  toolRule: copilotRuleRefusal,
});

/** Name of the Codex CLI harness (issue #50). */
export const CODEX_HARNESS = "codex";

/**
 * Codex CLI (codex-cli 0.167.1, docs/harnesses.md): no tool allow-list, only a sandbox mode
 * (`dontAsk` = read-only, `acceptEdits` = workspace-write, network off), no dollars (every run
 * `unpriced`), no project-defined agents (nothing in the CLI loads one from a project folder).
 * Resumable (#485): `codex exec resume` with `-c sandbox_mode` keeps the agent's sandbox on the
 * resumed turn; `resume_budget_usd` stays refused (no `hardBudgetUsd`). `codex_network: true`
 * (#488) only with `acceptEdits`: what `read-only` plus network means in Codex was never checked.
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = Object.freeze({
  toolAllowList: false,
  permissionModes: ["dontAsk", "acceptEdits"] as const,
  resumeSession: true,
  hardBudgetUsd: false,
  reportsCostUsd: false,
  subagents: false,
  mcpInherit: false,
  projectAgents: false,
  addDirs: false,
  skills: false,
  effort: true,
  sandbox: false,
  networkModes: ["acceptEdits"] as const,
});

/**
 * What `codex_network: true` grants (issue #488), verified by hand on codex-cli 0.167.1
 * (docs/security.md "Codex agents and the network").
 */
export const CODEX_NETWORK_GRANT =
  "codex_network: true gives every command of this agent's runs the network, every host (Codex has no host allow-list and no tool allow-list), acting with the credentials of the user who runs Duskfleet: the gh keyring login, SSH keys, git credential helpers. It can push to every repository that login can. Prefer a dedicated machine user or a scoped login, and isolated worktrees (docs/security.md)";

/**
 * Codex drops every variable whose name contains KEY, SECRET or TOKEN from the environment of the
 * commands a run executes (verified on codex-cli 0.167.1, #488; no `shell_environment_policy`
 * override tried brought one back).
 */
const CODEX_DROPPED_ENV = /KEY|SECRET|TOKEN/i;

/**
 * Advice that never refuses the write, for create / update and `agents create`: what a Codex
 * agent's `codex_network` grants, and the `env_passthrough` names Codex does not hand to commands.
 */
export function harnessGrantWarnings(
  agent: Pick<AgentDefinition, "harness" | "codexNetwork" | "envPassthrough">,
): string[] {
  if (harnessOf(agent) !== CODEX_HARNESS) return [];
  const warnings: string[] = [];
  if (agent.codexNetwork) warnings.push(CODEX_NETWORK_GRANT);
  const dropped = (agent.envPassthrough ?? []).filter((name) => CODEX_DROPPED_ENV.test(name));
  if (dropped.length)
    warnings.push(
      `env_passthrough ${dropped.join(", ")}: Codex removes variables whose name contains KEY, SECRET or TOKEN from the environment of the commands it runs, so ${dropped.length === 1 ? "this one has" : "these have"} no effect inside a Codex run (docs/agents.md "Codex agents")`,
    );
  return warnings;
}

/** The harnesses Duskfleet ships an adapter for, in the order `doctor` lists them. */
export const SHIPPED_HARNESSES: readonly string[] = [DEFAULT_HARNESS, COPILOT_HARNESS, CODEX_HARNESS];

/** The capabilities of a harness by name; undefined = no executor registered under that name. */
export type HarnessLookup = (name: string) => HarnessCapabilities | undefined;

/** What create / update check against when the caller has no registry at hand: the harnesses that ship. */
export const builtinHarnesses: HarnessLookup = (name) =>
  name === DEFAULT_HARNESS
    ? CLAUDE_CAPABILITIES
    : name === COPILOT_HARNESS
      ? COPILOT_CAPABILITIES
      : name === CODEX_HARNESS
        ? CODEX_CAPABILITIES
        : undefined;

/** The agent's harness name (`harness:`, else the default). */
export function harnessOf(agent: { harness?: string | undefined }): string {
  return agent.harness ?? DEFAULT_HARNESS;
}

type FitFields = Pick<
  AgentSpec,
  | "harness"
  | "allowed_tools"
  | "disallowed_tools"
  | "permission_mode"
  | "on_failure"
  | "resume_budget_usd"
  | "max_budget_usd"
  | "wrap_up_reserve_usd"
  | "max_daily_cost_usd"
  | "inherit_mcp"
  | "claude_agent"
  | "add_dirs"
  | "skills"
  | "effort"
  | "sandbox"
  | "sandbox_allowed_domains"
  | "sandbox_weaker_network_isolation"
  | "codex_network"
>;

/**
 * Why the agent cannot run on its harness, or null when it fits: an unknown harness, or the first
 * field it sets that the harness does not declare. `project` (run start only) adds the project's
 * `inherit_mcp` / `add_dirs`, which reach the run too.
 */
export function harnessRefusal(
  spec: FitFields,
  harnesses: HarnessLookup,
  project?: Pick<ProjectDefinition, "id" | "inheritMcp" | "addDirs"> | null,
): string | null {
  const name = harnessOf(spec);
  const caps = harnesses(name);
  if (!caps) return `unknown harness "${name}": no executor is registered under that name`;
  const refuse = (field: string) => `${field} is not supported by harness ${name}`;
  if (spec.allowed_tools !== undefined && !caps.toolAllowList) return refuse("allowed_tools");
  if (spec.disallowed_tools !== undefined && !caps.toolAllowList) return refuse("disallowed_tools");
  if (caps.toolRule) {
    for (const [field, rules] of [
      ["allowed_tools", spec.allowed_tools],
      ["disallowed_tools", spec.disallowed_tools],
    ] as const) {
      for (const rule of rules ?? []) {
        const why = caps.toolRule(rule);
        if (why) return `${field} entry "${rule}" ${why}`;
      }
    }
  }
  if (spec.permission_mode !== undefined && !caps.permissionModes.includes(spec.permission_mode))
    return `permission_mode ${spec.permission_mode} is not supported by harness ${name} (accepted: ${caps.permissionModes.join(", ") || "none"})`;
  if (spec.on_failure === "resume_once" && !caps.resumeSession) return refuse("on_failure: resume_once");
  if (spec.resume_budget_usd !== undefined && !(caps.resumeSession && caps.hardBudgetUsd))
    return refuse("resume_budget_usd");
  if (spec.max_budget_usd !== undefined && !caps.hardBudgetUsd) return refuse("max_budget_usd");
  if (spec.wrap_up_reserve_usd !== undefined && !caps.hardBudgetUsd) return refuse("wrap_up_reserve_usd");
  // The daily cost cap sums reported costs: without them it would read 0 and never refuse.
  if (spec.max_daily_cost_usd !== undefined && !caps.reportsCostUsd) return refuse("max_daily_cost_usd");
  if (spec.inherit_mcp === true && !caps.mcpInherit) return refuse("inherit_mcp");
  if (spec.claude_agent !== undefined && !caps.projectAgents) return refuse("claude_agent");
  if (spec.add_dirs?.length && !caps.addDirs) return refuse("add_dirs");
  if (spec.skills?.length && !caps.skills) return refuse("skills");
  if (spec.effort !== undefined && !caps.effort) return refuse("effort");
  if (spec.sandbox === true && !caps.sandbox) return refuse("sandbox");
  if (spec.sandbox_allowed_domains !== undefined && !caps.sandbox) return refuse("sandbox_allowed_domains");
  if (spec.sandbox_weaker_network_isolation !== undefined && !caps.sandbox)
    return refuse("sandbox_weaker_network_isolation");
  if (spec.codex_network === true) {
    const modes = caps.networkModes ?? [];
    if (!modes.length) return refuse("codex_network");
    // The schema's default mode when the spec leaves it out.
    const mode = spec.permission_mode ?? "acceptEdits";
    if (!modes.includes(mode))
      return `codex_network needs permission_mode ${modes.join(" or ")} on harness ${name} (this agent has ${mode}): the network is not offered to a read-only agent`;
  }
  if (project?.inheritMcp && !caps.mcpInherit) return `${refuse("inherit_mcp")} (set by project ${project.id})`;
  if (project?.addDirs?.length && !caps.addDirs) return `${refuse("add_dirs")} (set by project ${project.id})`;
  return null;
}

/** Throws `harnessRefusal`'s reason, prefixed with the agent id. Create / update and `startRun` call it. */
export function assertAgentFitsHarness(
  agent: AgentDefinition | (FitFields & { id: string }),
  harnesses: HarnessLookup,
  project?: Pick<ProjectDefinition, "id" | "inheritMcp" | "addDirs"> | null,
): void {
  const spec: FitFields = "sourcePath" in agent ? agentToSpec(agent) : agent;
  const reason = harnessRefusal(spec, harnesses, project);
  if (reason) throw new Error(`agent "${agent.id}": ${reason}`);
}

/**
 * The executors this process can spawn, by harness name. `RunManager` picks one per run from the
 * agent's harness; `doctor` lists them all. A bare executor without `harness` / `capabilities` (an
 * older test double) is taken as the Claude harness.
 */
export class HarnessRegistry {
  private readonly byName = new Map<string, Executor>();

  constructor(executors: Executor | readonly Executor[]) {
    for (const executor of Array.isArray(executors) ? executors : [executors as Executor]) {
      const name = executor.harness ?? DEFAULT_HARNESS;
      if (this.byName.has(name)) throw new Error(`two executors registered for harness "${name}"`);
      this.byName.set(name, executor);
    }
  }

  /** Harness names, registration order. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): Executor | undefined {
    return this.byName.get(name);
  }

  capabilities(name: string): HarnessCapabilities | undefined {
    const executor = this.byName.get(name);
    if (!executor) return undefined;
    return executor.capabilities ?? (name === DEFAULT_HARNESS ? CLAUDE_CAPABILITIES : undefined);
  }

  /** The registry as a `HarnessLookup` for `assertAgentFitsHarness`. */
  readonly lookup: HarnessLookup = (name) => this.capabilities(name);
}
