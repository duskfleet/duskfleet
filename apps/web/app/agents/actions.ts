"use server";

import path from "node:path";
import {
  agentToSpec,
  deleteAgentFile,
  deleteSkippedUserAgentFiles,
  loadAgentDir,
  skippedAgentError,
  skippedUserAgentFiles,
  writeAgentFile,
} from "@duskfleet/core";
/**
 * The dashboard's writes on agents: edits to *user* agent files (data/agents).
 * Builtins stay versioned and are never edited here; runs are never touched
 * (schedules and settings have their own actions). Same rules as the MCP tools, re-implemented on the core API so the
 * dashboard keeps depending on core only.
 */
import { revalidatePath } from "next/cache";
import { config } from "@/lib/data";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export async function deleteAgentAction(id: string): Promise<ActionResult> {
  const cfg = config();
  const agent = cfg.agents.get(id);
  // A user file that does not load (#462) is deleted by path: its name may differ from its id.
  const broken = agent ? [] : skippedUserAgentFiles(cfg, id);
  if (!agent && !broken.length) return { ok: false, message: skippedAgentError(cfg, id) ?? `Agent "${id}" not found.` };
  if (agent && agent.source !== "user")
    return { ok: false, message: `"${id}" is a builtin agent (config/agents): edit the repo, not the dashboard.` };
  // Lenient read: one broken builtin file must not break the delete of another agent.
  const builtinRemains = loadAgentDir(path.join(cfg.configDir, "agents"), "builtin").agents.has(id);
  if (id === cfg.defaultAgent && !builtinRemains) {
    return {
      ok: false,
      message: `"${id}" is the default_agent in duskfleet.yaml and has no builtin fallback. Change default_agent first.`,
    };
  }
  if (broken.length) deleteSkippedUserAgentFiles(cfg, id);
  else deleteAgentFile(cfg.userAgentsDir, id);
  revalidatePath("/agents");
  revalidatePath("/");
  return {
    ok: true,
    message: builtinRemains ? `Deleted the user override; the builtin "${id}" is active again.` : `Deleted "${id}".`,
  };
}

/** Remove the claude_agent link: the agent keeps its envelope and its own prompt body. */
export async function unlinkAgentAction(id: string): Promise<ActionResult> {
  const cfg = config();
  const agent = cfg.agents.get(id);
  if (!agent) return { ok: false, message: `Agent "${id}" not found.` };
  if (agent.source !== "user")
    return { ok: false, message: `"${id}" is a builtin agent: edit the repo, not the dashboard.` };
  if (!agent.claudeAgent) return { ok: false, message: `"${id}" is not linked to a project agent.` };
  const { claude_agent: _link, ...spec } = agentToSpec(agent);
  writeAgentFile(cfg.userAgentsDir, spec);
  revalidatePath("/agents");
  return {
    ok: true,
    message: spec.system_prompt.trim()
      ? `Unlinked: "${id}" now runs with its own prompt.`
      : `Unlinked: "${id}" has an empty prompt now; add one with update_agent or it will run with only Claude Code's defaults.`,
  };
}
