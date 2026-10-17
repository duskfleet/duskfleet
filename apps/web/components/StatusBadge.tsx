import type { Run, RunStatus } from "@duskfleet/core";

/**
 * Status with a verdict: a completed run that needed a human (permission
 * denial, exhausted context) is shown in amber, not green. The raw status
 * is still visible in the title.
 */
type VerdictRun = Pick<Run, "status" | "humanIntervention" | "contextExhausted" | "permissionDenials"> & { mcp?: Run["mcp"] };

/** The amber rule, shared with places that only need the verdict (schedule firings). */
export function needsReview(run: VerdictRun): boolean {
  const mcpMissing = (run.mcp?.allowListedMissing ?? []).length > 0;
  return run.status === "completed" && (run.humanIntervention || run.contextExhausted || mcpMissing);
}

export function StatusBadge({ run, status }: { run?: VerdictRun; status?: RunStatus }) {
  const s = run?.status ?? status ?? "pending";
  const mcpMissing = (run?.mcp?.allowListedMissing ?? []).length > 0;
  const attention = run && needsReview(run);
  const label = attention ? "needs review" : s.replace("_", " ");
  const cls = attention ? "attention" : s;
  const title = attention
    ? [run.permissionDenials ? `${run.permissionDenials} permission denial(s)` : null, run.contextExhausted ? "context exhausted" : null, mcpMissing ? "allow-listed MCP server not mounted" : null]
        .filter(Boolean)
        .join(" · ")
    : s;
  return (
    <span className={`badge ${cls}`} title={title}>
      {label}
    </span>
  );
}
