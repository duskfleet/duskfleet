/**
 * The one create / update path for agent files, shared by the MCP tools (`create_agent`,
 * `update_agent`) and the CLI (`agents create`): validate everything the loader would reject
 * *before* a file lands on disk, write it, reload the config and roll the file back when it no
 * longer loads. One bad agent file would otherwise break every later config reload.
 */
import {
  type AgentKind,
  type AgentSpec,
  agentSpecSchema,
  assertAgentKind,
  assertWrapUpReserve,
  deleteAgentFile,
  writeAgentFile,
} from "./agent-files.js";
import { assertAgentSpecClean } from "./agent-lint.js";
import type { AgentDefinition, DuskFleetConfig } from "./types.js";

/** Validate what the loader would reject, *before* a file lands on disk and breaks every later config load. */
export function assertSpecLoadable(spec: AgentSpec, config: DuskFleetConfig): void {
  if (spec.project && !config.projects.has(spec.project)) {
    throw new Error(
      `project "${spec.project}" is not in projects.yaml. Known projects: ${[...config.projects.keys()].join(", ") || "(none)"}`,
    );
  }
}

/** The kind combination (`assertAgentKind`) and the wrap-up reserve cap, against the current config. */
export function assertAgentWritable(kind: AgentKind, spec: AgentSpec, config: DuskFleetConfig): void {
  assertAgentKind(kind, spec, (id) => config.projects.get(id)?.path ?? null);
  assertWrapUpReserve(spec, config.claude.defaultMaxBudgetUsd);
}

/**
 * Refuses an id that already exists unless `overwrite` is set. `overwriteHint` names the caller's
 * switch ("overwrite: true" for MCP, "--force" for the CLI). Returns the existing agent, if any.
 */
export function assertAgentIdFree(
  config: DuskFleetConfig,
  id: string,
  overwrite: boolean,
  overwriteHint: string,
  updateHint: string | null,
): AgentDefinition | undefined {
  const existing = config.agents.get(id);
  if (existing && !overwrite) {
    throw new Error(
      existing.source === "user"
        ? `agent "${id}" already exists (${existing.sourcePath}). ${updateHint ? `Use ${updateHint}, or pass` : "Pass"} ${overwriteHint} to replace it.`
        : `"${id}" is a builtin agent (${existing.sourcePath}). Pass ${overwriteHint} to create a user override, or choose another id.`,
    );
  }
  return existing;
}

/**
 * Write the agent file into `user_agents_dir`, then make sure the config still loads (`reload`
 * re-reads it from disk and keeps the previous one on failure); otherwise remove the file and fail loudly.
 */
export function writeAgentAndVerify(
  config: DuskFleetConfig,
  spec: AgentSpec,
  reload: () => DuskFleetConfig,
): AgentDefinition {
  assertSpecLoadable(spec, config);
  const file = writeAgentFile(config.userAgentsDir, spec);
  const fresh = reload().agents.get(spec.id);
  if (!fresh || fresh.sourcePath !== file) {
    deleteAgentFile(config.userAgentsDir, spec.id);
    throw new Error(`agent file ${file} did not load (see server log); it has been removed again`);
  }
  return fresh;
}

/**
 * Parse raw fields into a spec, refuse home paths and secret-looking values, check the kind,
 * then write and verify. Nothing is left on disk when any step fails.
 */
export function createAgentFromFields(
  kind: AgentKind,
  fields: unknown,
  config: DuskFleetConfig,
  reload: () => DuskFleetConfig,
): AgentDefinition {
  const spec = assertAgentSpecClean(agentSpecSchema.parse(fields));
  assertAgentWritable(kind, spec, config);
  return writeAgentAndVerify(config, spec, reload);
}
