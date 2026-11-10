/**
 * `duskfleet mcp status` for a human: one block per MCP host. Env keys only, never their values
 * (`--json` prints the entry as the host's config holds it).
 */
import type { McpTarget, McpTargetStatus } from "../mcp-register.js";
import { kv, type RenderOpts, section, sections } from "./primitives.js";

const TARGET_TITLE: Readonly<Record<McpTarget, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
};

export function renderMcpStatus(statuses: readonly McpTargetStatus[], opts: RenderOpts): string[] {
  return sections(
    statuses.map((s) => {
      const command = s.command === null ? null : [s.command, ...s.args].join(" ");
      const envKeys = Object.keys(s.env);
      return section(
        TARGET_TITLE[s.target] ?? s.target,
        kv(
          [
            ["registered", s.registered ? { text: "yes", role: "ok" } : { text: "no", role: "muted" }],
            ["config", s.configPath],
            ["command", command],
            ["env", envKeys.length ? envKeys.join(", ") : null],
            ["error", s.error ? { text: s.error, role: "bad" } : null],
          ],
          opts,
        ),
        opts,
      );
    }),
  );
}
