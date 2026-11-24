/**
 * Where a link's project agent lives and how its harness starts it (#466): Claude Code's
 * `.claude/agents/<name>.md` run as `claude --agent <name>`, Copilot's `.github/agents/<name>.agent.md`
 * run as `copilot --agent <name>`. The folder comes from core (`linkFolder`), never a literal here.
 *
 * Pure (no database, no `server-only`): pages and lib/data.ts call it, the tests feed it.
 */
import { harnessOf, linkFolder, type ProjectAgentFolder, projectAgentFile } from "@duskfleet/core";

export interface LinkTarget {
  /** The harness's folder of project agents. */
  folder: ProjectAgentFolder;
  /** The project agent's file, relative to the project root: `.github/agents/pim.agent.md`. */
  file: string;
  /** What the run is, for humans: `copilot --agent pim`. */
  command: string;
}

/** The link target of an agent with `claude_agent` / `project_agent` `name` on its harness. */
export function linkTarget(agent: { harness?: string | undefined }, name: string): LinkTarget {
  const folder = linkFolder(agent);
  return { folder, file: projectAgentFile(folder, name), command: `${harnessOf(agent)} --agent ${name}` };
}
