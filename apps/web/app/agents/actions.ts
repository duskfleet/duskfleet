"use server";

import path from "node:path";
import { agentToSpec, deleteAgentFile, loadAgents, writeAgentFile } from "@duskfleet/core";
/**
 * The only writes the dashboard performs: edits to *user* agent files
 * (data/agents). Builtins stay versioned and read-only here; runs are never
 * touched. Same rules as the MCP tools, re-implemented on the core API so the
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
  if (!agent) return { ok: false, message: `Agent "${id}" not found.` };
  if (agent.source !== "user")
    return { ok: false, message: `"${id}" is a builtin agent (config/agents): edit the repo, not the dashboard.` };
  const builtinRemains = loadAgents(path.join(cfg.configDir, "agents"), "builtin").has(id);
  if (id === cfg.defaultAgent && !builtinRemains) {
    return {
      ok: false,
      message: `"${id}" is the default_agent in duskfleet.yaml and has no builtin fallback. Change default_agent first.`,
    };
  }
  deleteAgentFile(cfg.userAgentsDir, id);
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
