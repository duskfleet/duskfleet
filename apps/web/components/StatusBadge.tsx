import type { ReviewReason, Run, RunStatus } from "@duskfleet/core";
import { badgeVerdict } from "@/lib/status";

type BadgeRun = Pick<Run, "status" | "reviewReasons">;

/**
 * Status with a verdict, from the review reasons `RunManager` stored when the run ended
 * (the same value `list_runs` returns): a completed run that needs a human (denial,
 * exhausted context, MCP mismatch) is amber, not green; a failed or timed-out run is red
 * and its title says why (budget exhausted, orphaned, non-zero exit...). The raw status is
 * always in the title.
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
  const { label, cls, title } = badgeVerdict(s, given ?? run?.reviewReasons ?? []);
  return (
    <span className={`badge ${cls}`} title={title}>
      {label}
    </span>
  );
}
