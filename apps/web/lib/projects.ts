import type { Run } from "@duskfleet/core";

/** The agent chips a project row shows: the first `max`, then "+N" for the rest. */
export function agentChips(agents: readonly string[], max = 2): { shown: string[]; more: number } {
  return { shown: agents.slice(0, max), more: Math.max(0, agents.length - max) };
}

/** The amber pill: a completed run with a stored review reason (the same verdict as StatusBadge). */
export function lastRunNeedsReview(run: Pick<Run, "status" | "reviewReasons"> | null): boolean {
  return run?.status === "completed" && run.reviewReasons.length > 0;
}

/** "now", "40 min ago", "3 d ago" from a `fmtAgo` value; a short date stays as it is. */
export function agoText(ago: string): string {
  return /^\d+ (min|h|d)$/.test(ago) ? `${ago} ago` : ago;
}
