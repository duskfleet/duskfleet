/**
 * Where a harness's project agents live (issue #494): the one source for every text that names
 * that folder (server instructions, tool descriptions, errors, hints). Owner decision 2026-11-23:
 * the folder is fixed per harness, and no other folder is ever proposed for that harness. Whether a
 * `link` can run there is a separate capability (`projectAgents`).
 *
 * No imports: both `agent-files.ts` and `execution/harness.ts` use it.
 */

/** A harness's folder of agent definitions inside a project repository. */
export interface ProjectAgentFolder {
  /** Relative to the project root, POSIX separators: `.claude/agents`. */
  dir: string;
  /** One agent's file, `<name>` standing for the agent: `<name>.md`, `<name>.agent.md`, `<file>.toml`. */
  file: string;
  /** `markdown` = YAML frontmatter + body; `toml` = one table whose `name` key identifies the agent. */
  format: "markdown" | "toml";
}

/** Claude Code: `.claude/agents/<name>.md`, run with `claude --agent <name>`. */
export const CLAUDE_PROJECT_AGENTS: ProjectAgentFolder = Object.freeze({
  dir: ".claude/agents",
  file: "<name>.md",
  format: "markdown",
});

/** GitHub Copilot CLI: `.github/agents/<name>.agent.md` (`copilot --help`, 1.0.114). */
export const COPILOT_PROJECT_AGENTS: ProjectAgentFolder = Object.freeze({
  dir: ".github/agents",
  file: "<name>.agent.md",
  format: "markdown",
});

/** Codex CLI: `.codex/agents/*.toml`, the `name` field (not the file name) identifies the agent. */
export const CODEX_PROJECT_AGENTS: ProjectAgentFolder = Object.freeze({
  dir: ".codex/agents",
  file: "<file>.toml",
  format: "toml",
});

/**
 * Cursor Agent CLI: `.cursor/agents/<name>.md` (fixture `subagent`, #467). The CLI runs them only as
 * subagents called from the prompt, never as the session, so a link cannot run one.
 */
export const CURSOR_PROJECT_AGENTS: ProjectAgentFolder = Object.freeze({
  dir: ".cursor/agents",
  file: "<name>.md",
  format: "markdown",
});

/** `.claude/agents/<name>.md`, with `<name>` replaced when given. */
export function projectAgentFile(folder: ProjectAgentFolder, name?: string): string {
  const file =
    name !== undefined && folder.file.startsWith("<name>") ? folder.file.replace("<name>", name) : folder.file;
  return `${folder.dir}/${file}`;
}

/** The file-name suffix that marks one agent definition in the folder: `.md`, `.agent.md`, `.toml`. */
export function projectAgentSuffix(folder: ProjectAgentFolder): string {
  return folder.file.replace(/^<[a-z]+>/, "");
}
