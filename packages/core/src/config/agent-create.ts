/**
 * The one create / update path for agent files, shared by the MCP tools (`create_agent`,
 * `update_agent`) and the CLI (`agents create`): validate everything the loader would reject
 * *before* a file lands on disk, write it, reload the config and roll the file back when it no
 * longer loads. One bad agent file would otherwise break every later config reload.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertAgentFitsHarness,
  builtinHarnesses,
  type HarnessLookup,
  harnessOf,
  projectAgentFolderOf,
} from "../execution/harness.js";
import {
  type AgentKind,
  type AgentSpec,
  agentFilePath,
  agentSpecSchema,
  assertAgentKind,
  assertSandboxSpec,
  assertWrapUpReserve,
  deleteAgentFileAt,
  writeAgentFile,
  writeAgentFileAt,
} from "./agent-files.js";
import { assertAgentSpecClean } from "./agent-lint.js";
import { assertSkillsAvailable } from "./skills.js";
import type { AgentDefinition, DuskFleetConfig, SkippedAgentFile } from "./types.js";

/** Validate what the loader would reject, *before* a file lands on disk and breaks every later config load. */
export function assertSpecLoadable(spec: AgentSpec, config: DuskFleetConfig): void {
  if (spec.project && !config.projects.has(spec.project)) {
    throw new Error(
      `project "${spec.project}" is not in projects.yaml. Known projects: ${[...config.projects.keys()].join(", ") || "(none)"}`,
    );
  }
}

/**
 * The kind combination (`assertAgentKind`), the wrap-up reserve cap and the declared skills (each
 * one found in data/skills or config/skills, its files clean), against the current config.
 * `storedSkills` (update only) are the names the agent file already declares: they are not
 * re-checked, so a skill deleted since the agent was written (tolerated by the loader and at run
 * start) does not make an unrelated update fail. Only the names new against the stored spec are.
 */
export function assertAgentWritable(
  kind: AgentKind,
  spec: AgentSpec,
  config: DuskFleetConfig,
  storedSkills: readonly string[] = [],
  harnesses: HarnessLookup = builtinHarnesses,
): void {
  // The harness first: an unknown one, or a field it cannot honour, is refused with the field named.
  assertAgentFitsHarness(spec, harnesses);
  // A link is checked against its own harness's folder (#494), never another harness's.
  assertAgentKind(
    kind,
    spec,
    (id) => config.projects.get(id)?.path ?? null,
    projectAgentFolderOf(harnessOf(spec), harnesses),
  );
  assertWrapUpReserve(spec, config.claude.defaultMaxBudgetUsd);
  assertSandboxSpec(spec);
  const added = (spec.skills ?? []).filter((name) => !storedSkills.includes(name));
  if (added.length) assertSkillsAvailable(added, config);
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
  // A user file that does not load still owns its id (#462): never overwrite it silently.
  const broken = skippedUserAgentFiles(config, id)[0];
  if (broken && !overwrite) {
    throw new Error(
      `agent "${id}" exists but its file ${broken.sourcePath} does not load (${broken.error}). Fix the file, delete it, or pass ${overwriteHint} to replace it.`,
    );
  }
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
 * The user agent files declaring `id` that the loader skipped (#462). Empty when a valid user file
 * holds the id (a skipped duplicate then does not take it out, the valid file is what tools act on).
 */
export function skippedUserAgentFiles(config: DuskFleetConfig, id: string): SkippedAgentFile[] {
  if (config.agents.get(id)?.source === "user") return [];
  return (config.skippedAgents ?? []).filter((s) => s.id === id && s.source === "user");
}

/**
 * Removes the user files of `id` that do not load (#462), so a broken hand-edited file can be
 * deleted by the same tools as a valid one. Returns the removed paths (empty when there was none).
 */
export function deleteSkippedUserAgentFiles(config: DuskFleetConfig, id: string): string[] {
  const removed: string[] = [];
  for (const s of skippedUserAgentFiles(config, id)) {
    if (deleteAgentFileAt(config.userAgentsDir, s.sourcePath)) removed.push(s.sourcePath);
  }
  return removed;
}

/**
 * Refuses to write `<user_agents_dir>/<id>.md` when that file belongs to another agent (#501): a
 * user file, whatever its name, holds the id it declares, so `helper.md` declaring `code-helper`
 * is not agent `helper`'s file. No `overwrite` / `--force` lifts this: those replace the agent of
 * that id, never a different one. A file on disk the config does not know (written since the last
 * load) is refused too: what it holds is unknown.
 */
export function assertAgentFileFree(config: DuskFleetConfig, id: string): void {
  const file = agentFilePath(config.userAgentsDir, id);
  if (!existsSync(file)) return;
  const target = path.resolve(file);
  const holders: { id: string; sourcePath: string }[] = [
    ...[...config.agents.values()].filter((a) => a.source === "user"),
    ...(config.skippedAgents ?? []).filter((s) => s.source === "user"),
  ].filter((h) => path.resolve(h.sourcePath) === target);
  if (holders.some((h) => h.id === id)) return;
  const other = holders[0]?.id;
  throw new Error(
    other
      ? `${file} holds agent "${other}", not "${id}": writing it would delete that agent. Rename that file (e.g. to ${other}.md) or choose another id.`
      : `${file} already exists and does not hold agent "${id}": writing it would replace that file. Move it away or choose another id.`,
  );
}

/**
 * The file a write of agent `id` goes to: the file a valid user agent of that id was loaded from,
 * whatever its name (#508: `a-hand.md` declaring `zed` is updated in place, never next to a new
 * `zed.md` that would make one of the two a skipped duplicate), else `<user_agents_dir>/<id>.md`.
 */
export function agentWriteTarget(config: DuskFleetConfig, id: string): string {
  const existing = config.agents.get(id);
  return existing?.source === "user" ? existing.sourcePath : agentFilePath(config.userAgentsDir, id);
}

/**
 * Write the agent file into `user_agents_dir` (`agentWriteTarget`: a user agent's own file, else
 * `<id>.md`), then make sure the config still loads (`reload` re-reads it from disk and keeps the
 * previous one on failure); otherwise put back what the file held before (or remove it when it is
 * new) and fail loudly. Never over a file that holds another agent (`assertAgentFileFree`).
 */
export function writeAgentAndVerify(
  config: DuskFleetConfig,
  spec: AgentSpec,
  reload: () => DuskFleetConfig,
): AgentDefinition {
  assertSpecLoadable(spec, config);
  const target = agentWriteTarget(config, spec.id);
  const inPlace = path.resolve(target) !== path.resolve(agentFilePath(config.userAgentsDir, spec.id));
  // The agent's own file holds this id by definition; `<id>.md` may hold another agent (#501).
  if (!inPlace) assertAgentFileFree(config, spec.id);
  const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
  const file = inPlace
    ? writeAgentFileAt(config.userAgentsDir, target, spec)
    : writeAgentFile(config.userAgentsDir, spec);
  const reloaded = reload();
  const fresh = reloaded.agents.get(spec.id);
  if (!fresh || path.resolve(fresh.sourcePath) !== path.resolve(file)) {
    if (previous === null) deleteAgentFileAt(config.userAgentsDir, file);
    else writeFileSync(file, previous, "utf8");
    reload();
    // The loader skips a file that does not load instead of throwing (#462): its entry says why.
    const why = reloaded.skippedAgents?.find((s) => path.resolve(s.sourcePath) === path.resolve(file))?.error;
    throw new Error(
      `agent file ${file} did not load (${why ?? "see server log"}); ${previous === null ? "it has been removed again" : "its previous content has been restored"}`,
    );
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
  harnesses: HarnessLookup = builtinHarnesses,
): AgentDefinition {
  const spec = assertAgentSpecClean(agentSpecSchema.parse(fields));
  assertAgentWritable(kind, spec, config, [], harnesses);
  return writeAgentAndVerify(config, spec, reload);
}
