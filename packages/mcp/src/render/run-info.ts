/**
 * `duskfleet run-info <id>` for a human: the run, its usage, how it ended, its subagents, what it
 * changed and (with `--events`) its event timeline. Receives exactly the object `--json` prints.
 */
import {
  FAILURE_LABELS,
  REVIEW_REASON_LABELS,
  type Run,
  type RunAgentView,
  type RunDiff,
  type RunEvent,
  runFixHint,
  summarizeWrapUp,
} from "@duskfleet/core";
import {
  badge,
  type Cell,
  type Column,
  fmtDuration,
  fmtRelative,
  fmtUsd,
  kv,
  oneLine,
  type RenderOpts,
  section,
  sections,
  table,
} from "./primitives.js";
import { costCell } from "./run.js";
import { paint } from "./theme.js";

export interface RunInfo {
  run: Run;
  label: string;
  costLabel: string;
  diff: RunDiff | null;
  subagents: RunAgentView[];
  events?: RunEvent[];
}

/** Files listed under Diff; the rest is counted. */
const DIFF_FILES_SHOWN = 20;

const fmtCount = (n: number | null | undefined) => (n === null || n === undefined ? null : n.toLocaleString("en-US"));

function when(iso: string | null, opts: RenderOpts): string | null {
  return iso ? `${iso} (${fmtRelative(iso, opts.now)})` : null;
}

function runBlock(info: RunInfo, opts: RenderOpts): string[] {
  const { run } = info;
  const reasons = run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ");
  const status = reasons
    ? `${badge(run.status, opts)} ${paint("warn", `needs review: ${reasons}`, opts)}`
    : badge(run.status, opts);
  return section(
    "Run",
    kv(
      [
        ["id", { text: run.id, role: "accent" }],
        ["label", info.label],
        ["status", status],
        ["agent", run.agentId],
        ["project", run.projectId ? `${run.projectId} (${run.projectPath})` : run.projectPath],
        ["model", run.modelUsed ?? run.modelRequested],
        ["session", run.claudeSessionId],
        ["created", when(run.createdAt, opts)],
        ["ended", when(run.endedAt, opts)],
        ["duration", run.durationMs !== null ? fmtDuration(run.durationMs) : null],
        ["log", run.logPath],
      ],
      opts,
    ),
    opts,
  );
}

function usageBlock(info: RunInfo, opts: RenderOpts): string[] {
  const { run } = info;
  const denied = [...new Set(run.deniedTools.map((d) => d.tool))];
  const tokens = [
    ["in", run.inputTokens],
    ["out", run.outputTokens],
    ["cache read", run.cacheReadTokens],
    ["cache write", run.cacheCreationTokens],
  ]
    .filter(([, n]) => n !== null)
    .map(([k, n]) => `${fmtCount(n as number)} ${k}`)
    .join(", ");
  const cost = costCell({ costUsd: run.costUsd, costLabel: info.costLabel, costStatus: run.costStatus });
  const costText = typeof cost === "string" ? cost : cost.text;
  return section(
    "Usage",
    kv(
      [
        ["turns", fmtCount(run.numTurns)],
        ["tool calls", fmtCount(run.toolCalls)],
        ["denied tools", denied.length ? { text: denied.join(", "), role: "warn" } : null],
        ["tokens", tokens || null],
        [
          info.costLabel.toLowerCase(),
          run.costUsd === null && !run.costStatus ? null : `${costText}${run.costStatus ? ` (${run.costStatus})` : ""}`,
        ],
      ],
      opts,
    ),
    opts,
  );
}

function outcomeBlock(info: RunInfo, opts: RenderOpts): string[] {
  const { run } = info;
  const wrapUp = summarizeWrapUp(run);
  return section(
    "Outcome",
    kv(
      [
        ["termination", run.terminationReason],
        ["exit code", run.exitCode !== null && run.exitCode !== 0 ? String(run.exitCode) : null],
        [
          "failure",
          run.errorCode
            ? {
                text: `${FAILURE_LABELS[run.errorCode]} (${run.errorCode}, ${run.errorFamily ?? "unknown"})`,
                role: "bad",
              }
            : null,
        ],
        ["error", run.error ? oneLine(run.error) : null],
        ["fix", runFixHint(run)],
        ["wrap-up", wrapUp ? `${wrapUp.outcome}, ${fmtUsd(wrapUp.costUsd)}, ${fmtDuration(wrapUp.durationMs)}` : null],
      ],
      opts,
    ),
    opts,
  );
}

const SUBAGENT_COLUMNS: readonly Column[] = [
  { header: "type" },
  { header: "status" },
  { header: "model", priority: 1 },
  { header: "tools", align: "right", priority: 2 },
  { header: "duration", align: "right", priority: 3 },
  { header: "description", flex: true },
];

function subagentBlock(info: RunInfo, opts: RenderOpts): string[] {
  if (info.subagents.length === 0) return [];
  const rows = info.subagents.map((s): Cell[] => [
    s.type,
    s.status,
    s.model ?? "-",
    String(s.toolCalls),
    fmtDuration(s.durationMs),
    s.description ? oneLine(s.description) : "",
  ]);
  return section("Subagents", table(SUBAGENT_COLUMNS, rows, { ...opts, width: opts.width - 2 }), opts);
}

function diffBlock(info: RunInfo, opts: RenderOpts): string[] {
  const d = info.diff;
  if (!d) return [];
  const range = d.head && d.head !== d.base ? `${d.base.slice(0, 7)}..${d.head.slice(0, 7)}` : d.base.slice(0, 7);
  const lines = [
    `${d.filesChanged} file${d.filesChanged === 1 ? "" : "s"} changed, ${paint("ok", `+${d.additions}`, opts)} ${paint("bad", `-${d.deletions}`, opts)}${d.totalsPartial ? " (partial)" : ""} · ${range}`,
  ];
  for (const f of d.changedFiles.slice(0, DIFF_FILES_SHOWN)) {
    const counts = f.additions === null || f.deletions === null ? "" : `  +${f.additions} -${f.deletions}`;
    lines.push(`${f.status.padEnd(9)} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}${counts}`);
  }
  const more = d.filesChanged - Math.min(d.changedFiles.length, DIFF_FILES_SHOWN);
  if (more > 0) lines.push(paint("faint", `… ${more} more`, opts));
  if (d.patchPath)
    lines.push(`${paint("muted", "patch:", opts)} ${d.patchPath}${d.patchTruncated ? " (truncated)" : ""}`);
  return section("Diff", lines, opts);
}

const EVENT_COLUMNS: readonly Column[] = [
  { header: "time" },
  { header: "type" },
  { header: "agent", priority: 1 },
  { header: "detail", flex: true },
];

function eventDetail(e: RunEvent): string {
  if (e.payload === null || e.payload === undefined) return "";
  return oneLine(typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload), 200);
}

function eventsBlock(info: RunInfo, opts: RenderOpts): string[] {
  if (!info.events) return [];
  if (info.events.length === 0) return section("Events", ["none"], opts);
  const rows = info.events.map((e): Cell[] => [
    { text: e.ts.slice(11, 19), role: "muted" },
    e.type,
    e.agentId ?? "main",
    eventDetail(e),
  ]);
  return section("Events", table(EVENT_COLUMNS, rows, { ...opts, width: opts.width - 2 }), opts);
}

export function renderRunInfo(info: RunInfo, opts: RenderOpts): string[] {
  return sections([
    runBlock(info, opts),
    usageBlock(info, opts),
    outcomeBlock(info, opts),
    subagentBlock(info, opts),
    diffBlock(info, opts),
    eventsBlock(info, opts),
  ]);
}
