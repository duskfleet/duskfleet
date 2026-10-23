/**
 * A run refused by the WIP guards (agent busy, project busy, max_concurrent_runs). The message
 * keeps those words for humans; the scheduler checks the class, never the text, to record a
 * tick as `deferred` (scheduler.defer_busy) or `skipped_busy`.
 */
export class BusyError extends Error {
  override readonly name = "BusyError";
}
