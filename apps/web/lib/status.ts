import { REVIEW_REASON_LABELS, type ReviewReason, type RunStatus } from "@duskfleet/core";

export type BadgeVerdict = { label: string; cls: string; title: string };

/**
 * What a status badge shows, from the review reasons `RunManager` stored when the run ended:
 * a completed run with any reason (a permission denial, exhausted context...) is "needs
 * review" (amber), never plain green; any other status keeps its own colour and the reasons
 * go in the title.
 */
export function badgeVerdict(status: RunStatus, reasons: readonly ReviewReason[]): BadgeVerdict {
  const raw = status.replace("_", " ");
  const attention = status === "completed" && reasons.length > 0;
  const why = reasons.map((r) => REVIEW_REASON_LABELS[r]).join(" · ");
  return {
    label: attention ? "needs review" : raw,
    cls: attention ? "attention" : status,
    title: reasons.length > 0 ? `${raw} · needs review: ${why}` : status,
  };
}
