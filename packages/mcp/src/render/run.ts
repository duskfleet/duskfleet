/**
 * What `duskfleet run` prints once the run has ended. Human mode: on stdout a header line
 * (`run <id> <status> · <duration> · <cost>`), the cause / fix / more lines when the run did not
 * end clean, and the log path. `--json`: the run record, trimmed of what nobody reads in a
 * terminal (the spawned argv with the system prompt, the raw result JSON), with the cause / fix
 * block on stderr as before; `--full` prints the whole record. The fix line comes from core's hint
 * table (`runFixHint`), the same one `doctor --probe` uses.
 */
import { FAILURE_LABELS, REVIEW_REASON_LABELS, type Run, runCostLabel, runFixHint } from "@duskfleet/core";
import { type Cell, fmtDuration, fmtUsd, oneLine, type RenderOpts } from "./primitives.js";
import { paint, STATUS_ROLE } from "./theme.js";

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

/** `failed`, `completed, needs review (budget exhausted)`, `timed out (timed out)`. */
function stateText(run: Run): string {
  const state =
    run.status === "completed" && run.reviewReasons.length > 0
      ? "completed, needs review"
      : run.status.replace("_", " ");
  const reasons = run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ");
  return `${state}${reasons ? ` (${reasons})` : ""}`;
}

/** The cause / fix / more lines of a run that did not end clean; empty otherwise. */
function failureLines(run: Run, opts: RenderOpts): string[] {
  if (!endedUnclean(run)) return [];
  const lines: string[] = [];
  const label = run.errorCode ? FAILURE_LABELS[run.errorCode] : null;
  const error = run.error ? oneLine(run.error, CAUSE_MAX_CHARS) : null;
  const cause = label && error ? `${label}: ${error}` : (label ?? error);
  if (cause) lines.push(`${paint("muted", "cause:", opts)} ${cause}`);
  const fix = runFixHint(run);
  if (fix) lines.push(`${paint("muted", "fix:", opts)} ${fix}`);
  lines.push(`${paint("muted", "more:", opts)} duskfleet run-info ${run.id}`);
  return lines;
}

/**
 * The stderr block of `run --json` for a run that did not end clean (failed, timed out, cancelled,
 * or completed but needs review); null for a clean completed run and for one still going (`--no-wait`).
 */
export function runReportLines(run: Run): string[] | null {
  if (!endedUnclean(run)) return null;
  return [`run ${run.id} ${stateText(run)}`, ...failureLines(run, { color: false, width: Number.POSITIVE_INFINITY })];
}

/**
 * One run's cost as a cell: `$0.0123` billed, `≈$0.0123` at API value (subscription or unknown
 * billing, the `costLabel` rule), `unpriced` when the run ended without a cost, `-` while unknown.
 */
export function costCell(run: {
  costUsd: number | null;
  costLabel: string;
  costStatus?: string | null | undefined;
}): Cell {
  if (run.costStatus === "unpriced") return { text: "unpriced", role: "warn" };
  if (run.costUsd === null) return { text: "-", role: "faint" };
  return `${run.costLabel === "API value" ? "≈" : ""}${fmtUsd(run.costUsd)}`;
}

/** Human stdout of `duskfleet run`: header, then the failure block when there is one, then the log path. */
export function renderRunResult(run: Run, opts: RenderOpts): string[] {
  const unclean = endedUnclean(run);
  const role = unclean && run.status === "completed" ? "warn" : STATUS_ROLE[run.status];
  const cost = costCell({ costUsd: run.costUsd, costLabel: runCostLabel(run.billingType), costStatus: run.costStatus });
  const parts = [
    `run ${paint("accent", run.id, opts)} ${paint(role, stateText(run), opts)}`,
    run.durationMs !== null ? fmtDuration(run.durationMs) : null,
    run.costUsd !== null || run.costStatus === "unpriced"
      ? typeof cost === "string"
        ? cost
        : paint(cost.role, cost.text, opts)
      : null,
  ].filter((p): p is string => p !== null);
  const lines = [parts.join(" · "), ...failureLines(run, opts)];
  if (run.logPath) lines.push(`${paint("muted", "log:", opts)} ${run.logPath}`);
  return lines;
}
