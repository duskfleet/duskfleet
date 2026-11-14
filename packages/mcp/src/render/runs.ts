/**
 * `duskfleet runs` for a human (DS-33): one row per run, newest first as `listRuns` returns them,
 * a `└` line under each run that needs a look (why, and what to do), then the cost footer and the
 * dim json line. 100 columns hold every column; narrower terminals drop TOOLS, then PROJECT, then
 * MODEL, and AGENT gives way down to 12 columns.
 */
import path from "node:path";
import { REVIEW_REASON_LABELS, runFixHint, type summarizeRun } from "@duskfleet/core";
import { COMMAND_HELP } from "../cli-help.js";
import {
  type Cell,
  type Column,
  emptyState,
  fmtAge,
  fmtCost,
  fmtDuration,
  followUp,
  jsonLine,
  type RenderOpts,
  shortModel,
  statusCell,
  table,
} from "./primitives.js";
import { costCell } from "./run.js";

export type RunListItem = ReturnType<typeof summarizeRun>;

/** Characters of a run id shown in lists; `run-info` takes this prefix. */
export const SHORT_ID = 8;

const COLUMNS: readonly Column[] = [
  { header: "ID", width: SHORT_ID },
  { header: "STATUS", width: 14 },
  { header: "AGENT", width: 18, flex: true, min: 12 },
  { header: "PROJECT", width: 12, priority: 2 },
  { header: "MODEL", width: 7, priority: 3 },
  { header: "AGE", width: 5, align: "right" },
  { header: "DURATION", width: 8, align: "right" },
  { header: "COST", width: 7, align: "right" },
  { header: "TOOLS", width: 5, align: "right", priority: 1 },
];

/** `└` lines start under STATUS (ID never drops). */
const FOLLOW_INDENT = SHORT_ID + 2;

/** What a row's `└` line says: review reasons and denied tools, or the failure and its hint. */
function followUpText(r: RunListItem): string | null {
  if (r.status === "failed" || r.status === "timed_out") {
    const what = [r.errorFamily, r.terminationReason].filter(Boolean).join("/");
    const hint = runFixHint({ ...r, error: null });
    const text = [what, hint].filter(Boolean).join(" · ");
    return text || null;
  }
  if (r.status === "completed" && r.needsReview) {
    const reasons = r.reviewReasons.map((x) => REVIEW_REASON_LABELS[x]).join(", ");
    const denied = [...new Set(r.deniedTools.map((d) => d.tool))];
    return denied.length ? `${reasons} · ${denied.length} denied: ${denied.join(", ")}` : reasons;
  }
  return null;
}

/** `total $0.29 · ~ estimated · ? unpriced, not in the total (1)`. */
function totalLine(runs: readonly RunListItem[]): string {
  const total = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const unpriced = runs.filter((r) => r.costStatus === "unpriced").length;
  const parts = [`total ${fmtCost(total)}`];
  if (runs.some((r) => r.costStatus === "estimated")) parts.push("~ estimated");
  if (unpriced > 0) parts.push(`? unpriced, not in the total (${unpriced})`);
  return parts.join(" · ");
}

/** `filter` is how the list was narrowed (`status=failed, limit=10`), shown in the footer. */
export function renderRuns(runs: readonly RunListItem[], opts: RenderOpts, filter?: string): string[] {
  if (runs.length === 0) return emptyState("no runs yet", COMMAND_HELP["run"]!.example, opts);
  const rows = runs.map((r): Cell[] => [
    { text: r.id.slice(0, SHORT_ID), role: "accent" },
    statusCell(r.status, r.needsReview),
    r.agentId,
    r.projectId ?? path.basename(r.projectPath),
    shortModel(r.model),
    fmtAge(r.createdAt, opts.now),
    fmtDuration(r.durationMs),
    costCell(r),
    r.toolCalls === null || r.toolCalls === undefined ? "-" : String(r.toolCalls),
  ]);
  const [header, ...body] = table(COLUMNS, rows, opts);
  const lines = [header!];
  body.forEach((line, i) => {
    lines.push(line);
    const text = followUpText(runs[i]!);
    if (text) lines.push(followUp(text, FOLLOW_INDENT, opts));
  });
  const count = `${runs.length} run${runs.length === 1 ? "" : "s"} · newest first${filter ? ` · filter: ${filter}` : ""}`;
  lines.push("", totalLine(runs), count, jsonLine(opts, "details: duskfleet run-info <id>"));
  return lines;
}
