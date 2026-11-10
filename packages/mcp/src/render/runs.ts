/**
 * `duskfleet runs` for a human: one table row per run (newest first, as `listRuns` returns them)
 * and the cost total in its true wording (core's `costTotalsLine`) as the last line.
 */
import path from "node:path";
import { type CostTotals, costTotalsLine, type summarizeRun } from "@duskfleet/core";
import { COMMAND_HELP } from "../cli-help.js";
import { type Cell, type Column, fmtDuration, fmtRelative, type RenderOpts, statusCell, table } from "./primitives.js";
import { costCell } from "./run.js";
import { paint } from "./theme.js";

export type RunListItem = ReturnType<typeof summarizeRun>;

/** Marks a run that needs review in the status column. */
const REVIEW_MARK = "!";

const COLUMNS: readonly Column[] = [
  { header: "when", priority: 3 },
  { header: "status" },
  { header: "id", priority: 6 },
  { header: "agent", priority: 5 },
  { header: "project", priority: 2 },
  { header: "label", flex: true },
  { header: "duration", align: "right", priority: 1 },
  { header: "cost", align: "right", priority: 4 },
];

function statusWithMark(run: RunListItem): Cell {
  const cell = statusCell(run.status);
  return run.needsReview ? { text: `${cell.text} ${REVIEW_MARK}`, role: "warn" } : cell;
}

export function renderRuns(runs: readonly RunListItem[], totals: CostTotals | null, opts: RenderOpts): string[] {
  if (runs.length === 0) {
    return ["no runs yet. Start one with:", `  ${COMMAND_HELP["run"]!.example}`];
  }
  const rows = runs.map((r): Cell[] => [
    { text: fmtRelative(r.createdAt, opts.now), role: "muted" },
    statusWithMark(r),
    { text: r.id, role: "faint" },
    r.agentId,
    r.projectId ?? path.basename(r.projectPath),
    r.label,
    fmtDuration(r.durationMs),
    costCell(r),
  ]);
  const lines = table(COLUMNS, rows, opts);
  if (runs.some((r) => r.needsReview)) {
    lines.push(paint("faint", `${REVIEW_MARK} needs review: duskfleet run-info <id>`, opts));
  }
  if (totals) lines.push("", costTotalsLine(totals));
  return lines;
}
