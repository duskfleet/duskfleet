/** What an agent is doing now (DS-21 `Agent/Status`). */
export type AgentState = "running" | "paused" | "review" | "idle";

/**
 * A live run wins; then a bound schedule the scheduler auto-paused; then the stored review
 * verdict of its last finished run; else idle.
 */
export function agentState(s: { running: boolean; autoPaused: boolean; lastNeedsReview: boolean }): AgentState {
  if (s.running) return "running";
  if (s.autoPaused) return "paused";
  if (s.lastNeedsReview) return "review";
  return "idle";
}

/** Clean % colour: >= 90 ok, 70 to 89 warn, below 70 bad-ink; nothing finished = no colour. */
export function cleanTone(clean: number, finished: number): "" | "ok" | "warn" | "bad" {
  if (finished === 0) return "";
  const pct = Math.round((clean / finished) * 100);
  return pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
}
