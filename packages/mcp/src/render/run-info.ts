/**
 * `duskfleet run-info <id>` for a human (DS-33): a `run <id>  <status>` title, then the Run, Usage,
 * Outcome, Subagents and Diff sections (Events only with `--events`), keys in a 14-column label,
 * and the dim json line with the log path last. Receives the object `--json` prints, plus the
 * agent's kind and source when the agent still loads (shown, never printed as JSON).
 */
import {
  REVIEW_REASON_LABELS,
  type Run,
  type RunAgentView,
  type RunDiff,
  type RunEvent,
  runFixHint,
  type SubagentStatus,
  summarizeWrapUp,
} from "@duskfleet/core";
import {
  badge,
  type Cell,
  type Column,
  fmtDuration,
  fmtUsd,
  fmtWhen,
  jsonLine,
  kv,
  oneLine,
  paintCell,
  type RenderOpts,
  type Segment,
  section,
  sections,
  statusCell,
  table,
} from "./primitives.js";
import { causeText } from "./run.js";
import { paint, type StateRole, stateSegments } from "./theme.js";

export interface RunInfo {
  run: Run;
  label: string;
  costLabel: string;
  diff: RunDiff | null;
  subagents: RunAgentView[];
  events?: RunEvent[];
  /** The agent as it loads now (`own` / `link`, builtin / user); absent when it no longer loads. */
  agent?: { kind: string; source: string } | null;
}

/** Width of the key column. */
const LABEL = 14;
/** Files listed under Diff; the rest is counted. */
const DIFF_FILES_SHOWN = 20;

const fmtCount = (n: number | null | undefined) => (n === null || n === undefined ? null : n.toLocaleString("en-US"));
const needsReview = (run: Run) => run.reviewReasons.length > 0;

function runBlock(info: RunInfo, opts: RenderOpts): string[] {
  const { run } = info;
  const model = run.modelUsed ?? run.modelRequested;
  return section(
    "Run",
    kv(
      [
        ["agent", info.agent ? `${run.agentId} (${info.agent.kind}, ${info.agent.source})` : run.agentId],
        ["project", run.projectId ? `${run.projectId} (${run.projectPath})` : run.projectPath],
        ["label", info.label],
        ["schedule", run.scheduleId],
        [
          "model",
          model
            ? `${model}${run.claudeCodeVersion ? ` (claude code ${run.claudeCodeVersion})` : ""}`
            : run.claudeCodeVersion
              ? `default (claude code ${run.claudeCodeVersion})`
              : null,
        ],
        ["session", run.claudeSessionId],
        ["created", fmtWhen(run.createdAt, opts.now)],
        ["duration", run.durationMs !== null ? fmtDuration(run.durationMs) : null],
      ],
      opts,
      LABEL,
    ),
    opts,
  );
}

function usageBlock(info: RunInfo, opts: RenderOpts): string[] {
  const { run } = info;
  const denied = [...new Set(run.deniedTools.map((d) => d.tool))];
  const cost =
    run.costUsd === null && !run.costStatus
      ? null
      : `${run.costUsd === null ? "?" : fmtUsd(run.costUsd)}${run.costStatus ? ` (${run.costStatus})` : ""}`;
  const toolCalls = fmtCount(run.toolCalls);
  const tools: Cell | null =
    toolCalls === null
      ? null
      : denied.length
        ? [
            { text: `${toolCalls} · `, role: null },
            { text: `denied: ${denied.join(", ")}`, role: "strong" },
          ]
        : toolCalls;
  return section(
    "Usage",
    kv(
      [
        [info.costLabel.toLowerCase(), cost],
        ["turns", fmtCount(run.numTurns)],
        ["tool calls", tools],
      ],
      opts,
      LABEL,
    ),
    opts,
  );
}

function outcomeBlock(info: RunInfo, opts: RenderOpts): string[] {
  const { run } = info;
  const wrapUp = summarizeWrapUp(run);
  const reasons = run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ");
  const exit = run.exitCode !== null && run.exitCode !== 0 ? `exit code ${run.exitCode}` : null;
  const failure = run.errorCode ? `${run.errorCode}, ${run.errorFamily ?? "unknown"}` : null;
  const cause = run.errorCode || run.error ? causeText(run) : null;
  return section(
    "Outcome",
    kv(
      [
        ["status", statusCell(run.status, needsReview(run))],
        ["reasons", reasons || null],
        ["termination", [run.terminationReason, exit].filter(Boolean).join(", ") || null],
        ["cause", cause ? (failure ? `${cause} (${failure})` : cause) : null],
        ["fix", runFixHint(run)],
        ["wrap-up", wrapUp ? `${wrapUp.outcome}, ${fmtUsd(wrapUp.costUsd)}, ${fmtDuration(wrapUp.durationMs)}` : null],
        ["human", run.humanIntervention ? "needed: a tool was denied" : null],
        ["context", run.contextExhausted ? "exhausted" : null],
      ],
      opts,
      LABEL,
    ),
    opts,
  );
}

const SUBAGENT_ROLE: Readonly<Record<SubagentStatus, [string, StateRole | null]>> = {
  running: ["●", "run"],
  completed: ["✓", "ok"],
  failed: ["✗", "bad"],
  interrupted: ["–", null],
};

const SUBAGENT_COLUMNS: readonly Column[] = [
  { header: "NAME", width: 18, flex: true },
  { header: "STATUS", width: 14 },
  { header: "TOKENS", width: 8, align: "right" },
  { header: "DURATION", width: 9, align: "right" },
];

function subagentBlock(info: RunInfo, opts: RenderOpts): string[] {
  if (info.subagents.length === 0) return [];
  const rows = info.subagents.map((s): Cell[] => {
    const [glyph, role] = SUBAGENT_ROLE[s.status] ?? ["–", null];
    return [s.type, stateSegments(glyph, s.status, role), fmtCount(s.totalTokens) ?? "-", fmtDuration(s.durationMs)];
  });
  return section("Subagents", table(SUBAGENT_COLUMNS, rows, { ...opts, width: opts.width - 2 }), opts);
}

function diffBlock(info: RunInfo, opts: RenderOpts): string[] {
  const d = info.diff;
  if (!d) return [];
  const range = d.head && d.head !== d.base ? `${d.base.slice(0, 7)}..${d.head.slice(0, 7)}` : d.base.slice(0, 7);
  const lines = [
    `${d.filesChanged} file${d.filesChanged === 1 ? "" : "s"} changed · +${d.additions} −${d.deletions}${d.totalsPartial ? " (partial)" : ""} · ${range}`,
  ];
  for (const f of d.changedFiles.slice(0, DIFF_FILES_SHOWN)) {
    const counts = f.additions === null || f.deletions === null ? "" : `  +${f.additions} −${f.deletions}`;
    lines.push(`${f.status.padEnd(9)} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}${counts}`);
  }
  const more = d.filesChanged - Math.min(d.changedFiles.length, DIFF_FILES_SHOWN);
  if (more > 0) lines.push(`… ${more} more`);
  if (d.patchPath)
    lines.push(`${paint("heading", "patch:", opts)} ${d.patchPath}${d.patchTruncated ? " (truncated)" : ""}`);
  return section("Diff", lines, opts);
}

/** Width of an event's kind. */
const EVENT_KIND = 10;

function eventDetail(e: RunEvent): string {
  if (e.payload === null || e.payload === undefined) return "";
  return oneLine(typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload), 200);
}

function eventsBlock(info: RunInfo, opts: RenderOpts): string[] {
  if (!info.events) return [];
  if (info.events.length === 0) return section("Events", ["none"], opts);
  const room = Math.max(0, opts.width - 2 - 8 - 2 - EVENT_KIND - 2);
  const lines = info.events.map((e) => {
    const kind = e.type.length > EVENT_KIND ? `${e.type.slice(0, EVENT_KIND - 1)}…` : e.type.padEnd(EVENT_KIND);
    const denied = /denied/.test(e.type);
    const detail = eventDetail(e);
    const segs: Segment[] = [
      { text: e.ts.slice(11, 19), role: "muted" },
      { text: "  ", role: null },
      { text: kind, role: denied ? "strong" : null },
      { text: "  ", role: null },
      { text: detail.length > room ? `${detail.slice(0, Math.max(0, room - 1))}…` : detail, role: null },
    ];
    return paintCell(segs, opts).trimEnd();
  });
  return section("Events", lines, opts);
}

export function renderRunInfo(info: RunInfo, opts: RenderOpts): string[] {
  const { run } = info;
  const title = `${paint("heading", "run", opts)} ${paint("accent", run.id, opts)}  ${badge(run.status, opts, needsReview(run))}`;
  return [
    ...sections([
      [title],
      runBlock(info, opts),
      usageBlock(info, opts),
      outcomeBlock(info, opts),
      subagentBlock(info, opts),
      diffBlock(info, opts),
      eventsBlock(info, opts),
    ]),
    "",
    jsonLine(opts, run.logPath ? `log: ${run.logPath}` : undefined),
  ];
}
