import { REVIEW_REASON_LABELS, type ReviewReason, type Run, type RunStatus } from "@duskfleet/core";

type BadgeRun = Pick<Run, "status" | "reviewReasons">;

/**
 * Status with a verdict, from the review reasons `RunManager` stored when the run ended
 * (the same value `list_runs` returns): a completed run that needs a human (denial,
 * exhausted context, MCP mismatch) is amber, not green; a failed or timed-out run is red
 * and its title says why (budget exhausted, orphaned, non-zero exit...). The raw status is
 * always in the title.
 */
export function StatusBadge({ run, status, reasons: given }: { run?: BadgeRun; status?: RunStatus; reasons?: ReviewReason[] }) {
  const s = run?.status ?? status ?? "pending";
  const reasons = given ?? run?.reviewReasons ?? [];
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
