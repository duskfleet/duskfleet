/**
 * Tool rules of the Copilot harness (issue #446). An agent on `harness: copilot` writes Copilot's own
 * rules in `allowed_tools` / `disallowed_tools`; they are passed verbatim to `--allow-tool` /
 * `--deny-tool` (verified against `copilot help permissions`, Copilot CLI 1.0.112).
 *
 * Claude's rules do not translate: Copilot matches a shell command by its first subcommand only
 * (`shell(gh pr)` covers `gh pr merge`), so `Bash(gh pr create:*)` has no equivalent and mapping it
 * would widen it. An entry in any other shape is refused, with the entry named; never rewritten.
 */

/** The rule kinds accepted: bare `shell` / `write` / `read` / `memory`, or `shell(..)`, `write(..)`, `read(..)`, `url(..)`. */
const COPILOT_RULE = /^(?:shell|write|read|memory)$|^(?:shell|write|read|url)\([^()]+\)$/;

/** The accepted shapes, for messages and docs. */
export const COPILOT_RULE_SHAPES =
  "shell, shell(<command>), write, write(<path>), read, read(<path>), url(<domain>), memory";

/**
 * Why `rule` is not a Copilot rule this harness accepts, or null when it is. MCP rules
 * (`<server>(tool)`) are refused until the harness supports `inherit_mcp`.
 */
export function copilotRuleRefusal(rule: string): string | null {
  if (COPILOT_RULE.test(rule)) return null;
  return `is not a Copilot tool rule (harness copilot takes Copilot's own rules, passed verbatim: ${COPILOT_RULE_SHAPES}; Claude rules such as Bash(...), Read, Edit or mcp__* are refused, never translated)`;
}
