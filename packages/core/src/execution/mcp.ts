/**
 * MCP naming shared by the executor and the orchestrator: how a server name becomes the
 * `mcp__<server>` prefix of its tools, which prefixes an allow-list refers to, and which of
 * those a child session's `init` line failed to mount.
 */
import type { McpServerInfo } from "./types.js";

/** `claude.ai Figma` -> `mcp__claude_ai_Figma`, the prefix of every tool of that server. */
export function mcpToolPrefix(serverName: string): string {
  return "mcp__" + serverName.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Server prefixes an allow-list names, by server (`mcp__x`) or by tool (`mcp__x__tool`); sorted, unique. */
export function allowListedMcpPrefixes(allowedTools: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const t of allowedTools) {
    if (!t.startsWith("mcp__")) continue;
    const m = /^(mcp__[^_].*?)(?:__|$)/.exec(t);
    prefixes.add(m ? m[1]! : t);
  }
  return [...prefixes].sort();
}

/** Required prefixes that match no reported server, whatever its status (a pending server counts as present). */
export function missingMcpServers(required: readonly string[], mounted: readonly McpServerInfo[]): string[] {
  const present = new Set(mounted.map((s) => mcpToolPrefix(s.name)));
  return required.filter((p) => !present.has(p));
}
