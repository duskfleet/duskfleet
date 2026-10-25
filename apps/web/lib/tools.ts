/** The shape filterTools reads: a tool name and the names of its input parameters. */
export interface FilterableTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> } | null;
}

/**
 * Tools whose name or one of whose parameter names contains the query, case-insensitive.
 * Spaces count as underscores, so "run agent" finds run_agent. An empty query keeps them all.
 */
export function filterTools<T extends FilterableTool>(tools: readonly T[], query: string | undefined): T[] {
  const q = (query ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!q) return [...tools];
  return tools.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      Object.keys(t.inputSchema?.properties ?? {}).some((p) => p.toLowerCase().includes(q)),
  );
}
