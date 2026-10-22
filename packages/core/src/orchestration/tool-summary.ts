/** Claude Code derives MCP tool prefixes from the server name: "claude.ai Figma" → "mcp__claude_ai_Figma". */
export function mcpToolPrefix(serverName: string): string {
  return "mcp__" + serverName.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Allow-listed MCP server prefixes that never showed up in a run: an `mcp__` entry of
 * `allowedTools` whose server prefix matches neither a mounted server nor a server actually
 * called (`used`, as prefixes). Mounted lists can be empty while connectors are still
 * connecting at init, so nothing is reported missing unless the run gave *some* MCP evidence.
 */
export function allowListedMcpMissing(
  allowedTools: readonly string[],
  mounted: readonly { name: string }[],
  used: readonly string[],
): string[] {
  const mountedPrefixes = new Set(mounted.map((m) => mcpToolPrefix(m.name)));
  if (mountedPrefixes.size === 0 && used.length === 0) return [];
  const allowListedPrefixes = new Set(
    allowedTools
      .filter((t) => t.startsWith("mcp__"))
      .map((t) => {
        const m = /^(mcp__[^_].*?)(?:__|$)/.exec(t);
        return m ? m[1]! : t;
      }),
  );
  return [...allowListedPrefixes].filter((p) => !mountedPrefixes.has(p) && !used.includes(p)).sort();
}

/**
 * One short line describing a tool call for timelines: the shell command for
 * Bash, the file for Read/Edit/Write, the first string field otherwise.
 */
export function summarizeToolInput(name: string, input: unknown, max = 120): string | null {
  if (input === null || typeof input !== "object") return null;
  const p = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof p[k] === "string" && (p[k] as string).trim()) return (p[k] as string).trim();
    return null;
  };
  let text: string | null;
  switch (name) {
    case "Bash":
      text = pick("command", "description");
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      text = pick("file_path", "notebook_path", "path");
      break;
    case "Grep":
    case "Glob":
      text = pick("pattern");
      break;
    case "Agent":
    case "Task":
      text = pick("description", "prompt");
      break;
    default:
      text =
        pick("description", "query", "url", "pattern", "command", "prompt") ??
        Object.values(p).find((v): v is string => typeof v === "string") ??
        null;
  }
  if (!text) return null;
  text = text.replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
