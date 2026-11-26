/**
 * Tool rules of the Cursor harness (issue #467). An agent on `harness: cursor` writes Cursor's own
 * permission rules in `allowed_tools` / `disallowed_tools`; the adapter copies them verbatim into
 * the `permissions.allow` / `permissions.deny` lists of the run's `cli-config.json` (shapes verified
 * on Cursor Agent CLI 2026.11.19 and 2026.11.22, fixtures in `packages/mcp/test/fixtures/cursor/`).
 *
 * Claude's rules do not translate (`Bash(gh pr create:*)` has no Cursor equivalent; a
 * `Shell(<command>)` rule does not confine the command's paths): an entry in any other shape is
 * refused, with the entry named, never rewritten. `Mcp(...)` is refused too: every Cursor run
 * denies `Mcp(*:*)` (MCP for Cursor agents is a later issue).
 */

/**
 * The rule kinds accepted: `Shell(<command>)`, `Read(<glob>)`, `Write(<glob>)`, `WebFetch(<domain>)`.
 * Only the kind and the outer parentheses are checked: any non-empty argument (parentheses included,
 * e.g. `Read(src/(app)/**)`) is left to the Cursor CLI.
 */
const CURSOR_RULE = /^(?:Shell|Read|Write|WebFetch)\(.+\)$/;

/** The accepted shapes, for messages and docs. */
export const CURSOR_RULE_SHAPES = "Shell(<command>), Read(<glob>), Write(<glob>), WebFetch(<domain>)";

/** Why `rule` is not a Cursor rule this harness accepts, or null when it is. */
export function cursorRuleRefusal(rule: string): string | null {
  if (/^Mcp\(/.test(rule))
    return "is an MCP rule: harness cursor denies every MCP tool (Mcp(*:*)) and takes no Mcp(...) entry";
  if (CURSOR_RULE.test(rule)) return null;
  return `is not a Cursor permission rule (harness cursor takes Cursor's own rules, written verbatim into its cli-config.json: ${CURSOR_RULE_SHAPES}; Claude rules such as Bash(...), Read, Edit or mcp__* are refused, never translated)`;
}
