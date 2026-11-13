/**
 * What `duskfleet run` prints once the run has ended. Human mode: on stdout a header line
 * (`run <id> <glyph status> · <duration> · <cost>`), the bold cause / fix / more lines when the run
 * did not end clean, and a dim `log: <path>` last. `--json`: the run record, trimmed of what nobody
 * reads in a terminal (the spawned argv with the system prompt, the raw result JSON), with the
 * cause / fix block on stderr as before; `--full` prints the whole record. The fix line comes from
 * core's hint table (`runFixHint`), the same one `doctor --probe` uses.
 */
import { FAILURE_LABELS, REVIEW_REASON_LABELS, type Run, runFixHint } from "@duskfleet/core";
import { type Cell, fmtDuration, fmtRunCost, oneLine, paintCell, type RenderOpts, statusCell } from "./primitives.js";
import { paint } from "./theme.js";

/** Longest cause line; the full error stays in the record and in `run-info`. */
const CAUSE_MAX_CHARS = 240;

/** The record without `command.argv` (it carries --append-system-prompt) and `rawResultJson`. */
export function trimmedRun(
  run: Run,
): Omit<Run, "rawResultJson" | "command"> & { command: Omit<Run["command"], "argv"> } {
  const { rawResultJson: _raw, command, ...rest } = run;
  return { ...rest, command: { binary: command.binary, cwd: command.cwd } };
}

/** A run that ended and needs a human: failed, timed out, cancelled, or completed with review reasons. */
function endedUnclean(run: Run): boolean {
  if (run.status === "pending" || run.status === "running") return false;
  return !(run.status === "completed" && run.reviewReasons.length === 0);
}

/** `failed`, `completed, needs review (budget exhausted)`, `timed out (timed out)`: the stderr wording. */
function stateText(run: Run): string {
  const state =
    run.status === "completed" && run.reviewReasons.length > 0
      ? "completed, needs review"
      : run.status.replace("_", " ");
  const reasons = run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ");
  return `${state}${reasons ? ` (${reasons})` : ""}`;
}

/** Why the run did not end clean, in one line: the failure label and error, else the review reasons. */
export function causeText(
  run: Pick<Run, "errorCode" | "error" | "reviewReasons">,
  max = CAUSE_MAX_CHARS,
): string | null {
  const label = run.errorCode ? FAILURE_LABELS[run.errorCode] : null;
  const error = run.error ? oneLine(run.error, max) : null;
  if (label || error) return label && error ? `${label}: ${error}` : (label ?? error);
  const reasons = run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ");
  return reasons || null;
}

/** The cause / fix / more lines of a run that did not end clean; empty otherwise. */
function failureLines(run: Run, opts: RenderOpts): string[] {
  if (!endedUnclean(run)) return [];
  const lines: string[] = [];
  const cause = causeText(run);
  if (cause) lines.push(`${paint("heading", "cause:", opts)} ${cause}`);
  const fix = runFixHint(run);
  if (fix) lines.push(`${paint("heading", "fix:", opts)} ${fix}`);
  lines.push(`${paint("heading", "more:", opts)} ${paint("accent", `duskfleet run-info ${run.id}`, opts)}`);
  return lines;
}

/**
 * The stderr block of `run --json` for a run that did not end clean (failed, timed out, cancelled,
 * or completed but needs review); null for a clean completed run and for one still going (`--no-wait`).
 */
export function runReportLines(run: Run): string[] | null {
  if (!endedUnclean(run)) return null;
  const plain = { color: false, width: Number.POSITIVE_INFINITY };
  const lines = failureLines(run, plain);
  // The stderr block keeps the reasons on its first line, so the cause line names the error only.
  const first = lines[0]?.startsWith("cause:") && !run.errorCode && !run.error ? 1 : 0;
  return [`run ${run.id} ${stateText(run)}`, ...lines.slice(first)];
}

/**
 * One run's cost as a cell: `$0.08` reported, `~$0.21` estimated (an API value, not billed),
 * `<$0.01` / `~<$0.01` under a cent, `?` unpriced (ended without a cost), `-` while unknown.
 */
export function costCell(run: { costUsd: number | null; costStatus?: string | null | undefined }): Cell {
  if (run.costStatus === "unpriced") return "?";
  if (run.costUsd === null) return "-";
  return `${run.costStatus === "estimated" ? "~" : ""}${fmtRunCost(run.costUsd)}`;
}

/** Human stdout of `duskfleet run`: header, then the failure block when there is one, then the log path. */
export function renderRunResult(run: Run, opts: RenderOpts): string[] {
  const parts = [
    `run ${paint("accent", run.id, opts)} ${paintCell(statusCell(run.status, run.reviewReasons.length > 0), opts)}`,
    run.durationMs !== null ? fmtDuration(run.durationMs) : null,
    run.costUsd !== null || run.costStatus === "unpriced" ? paintCell(costCell(run), opts) : null,
  ].filter((p): p is string => p !== null);
  const lines = [parts.join(" · "), ...failureLines(run, opts)];
  if (run.logPath) lines.push(paint("muted", `log: ${run.logPath}`, opts));
  return lines;
}
