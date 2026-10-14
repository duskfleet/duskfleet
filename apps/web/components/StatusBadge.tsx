import { REVIEW_REASON_LABELS, type ReviewReason, type Run, type RunStatus, reviewReasons } from "@duskfleet/core";

type BadgeRun = Pick<Run, "status" | "humanIntervention" | "contextExhausted" | "permissionDenials"> &
  Partial<Pick<Run, "terminationReason" | "error" | "exitCode" | "mcp">>;

/**
 * Status with a verdict, from the same `reviewReasons` rule as `list_runs`: a completed
 * run that needs a human (denial, exhausted context, MCP mismatch) is amber, not green;
 * a failed or timed-out run is red and its title says why (budget exhausted, orphaned,
 * non-zero exit...). The raw status is always in the title.
 */
export function StatusBadge({
  run,
  status,
  reasons: given,
}: {
  run?: BadgeRun;
  status?: RunStatus;
  reasons?: ReviewReason[];
}) {
  const s = run?.status ?? status ?? "pending";
  const reasons = given
    ? given
    : run
      ? reviewReasons({
          status: run.status,
          humanIntervention: run.humanIntervention,
          contextExhausted: run.contextExhausted,
          permissionDenials: run.permissionDenials,
          terminationReason: run.terminationReason ?? null,
          error: run.error ?? null,
          exitCode: run.exitCode ?? null,
          mcp: run.mcp ?? null,
        })
      : [];
  const why = reasons.map((r) => REVIEW_REASON_LABELS[r]).join(" · ");
  const attention = s === "completed" && reasons.length > 0;
  const label = attention ? "needs review" : s.replace("_", " ");
  const cls = attention ? "attention" : s;
  const title = reasons.length > 0 ? `${s.replace("_", " ")} · needs review: ${why}` : s;
  return (
    <span className={`badge ${cls}`} title={title}>
      {label}
    </span>
  );
}
