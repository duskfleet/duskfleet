/**
 * What `duskfleet run` prints once the run has ended: a few lines on stderr a human reads first
 * (status, cause, fix, where to look next), and on stdout the run record for scripts, trimmed of
 * what nobody reads in a terminal (the spawned argv with the system prompt, the raw result JSON).
 * `--json` prints the full record. The fix line comes from core's hint table (`runFixHint`), the
 * same one `doctor --probe` uses.
 */
import { FAILURE_LABELS, REVIEW_REASON_LABELS, type Run, runFixHint } from "@duskfleet/core";

/** Longest cause line; the full error stays in the record and in `run-info`. */
const CAUSE_MAX_CHARS = 240;

/** The record without `command.argv` (it carries --append-system-prompt) and `rawResultJson`. */
export function trimmedRun(
  run: Run,
): Omit<Run, "rawResultJson" | "command"> & { command: Omit<Run["command"], "argv"> } {
  const { rawResultJson: _raw, command, ...rest } = run;
  return { ...rest, command: { binary: command.binary, cwd: command.cwd } };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CAUSE_MAX_CHARS ? `${flat.slice(0, CAUSE_MAX_CHARS - 3)}...` : flat;
}

/**
 * The human block for a run that did not end clean (failed, timed out, cancelled, or completed
 * but needs review); null for a clean completed run and for one still going (`--no-wait`).
 */
export function runReportLines(run: Run): string[] | null {
  if (run.status === "pending" || run.status === "running") return null;
  if (run.status === "completed" && run.reviewReasons.length === 0) return null;
  const state = run.status === "completed" ? "completed, needs review" : run.status.replace("_", " ");
  const reasons = run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ");
  const lines = [`run ${run.id} ${state}${reasons ? ` (${reasons})` : ""}`];
  const label = run.errorCode ? FAILURE_LABELS[run.errorCode] : null;
  const error = run.error ? oneLine(run.error) : null;
  const cause = label && error ? `${label}: ${error}` : (label ?? error);
  if (cause) lines.push(`cause: ${cause}`);
  const fix = runFixHint(run);
  if (fix) lines.push(`fix: ${fix}`);
  lines.push(`more: duskfleet run-info ${run.id}, or the run's page in the dashboard; full record: run --json`);
  return lines;
}
