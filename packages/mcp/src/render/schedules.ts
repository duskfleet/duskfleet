/**
 * `duskfleet schedules` and `schedules run-now` for a human (DS-33). The list opens with the
 * scheduler's state (kill switch, who ticks, the lease, a pause in force) and the time zone, then one
 * row per schedule with how its last run *ended*, not only that the tick started it, and a `└` line
 * under a paused one. Narrow terminals drop FIRE/SKIP, then CRON, then LAST RUN.
 */
import type { Schedule, SchedulerStatus, ScheduleWithLastRun } from "@duskfleet/core";
import {
  type Cell,
  type Column,
  emptyState,
  fmtAge,
  fmtRelative,
  fmtRunCost,
  followUp,
  jsonLine,
  paintCell,
  type RenderOpts,
  type Segment,
  table,
} from "./primitives.js";
import { GLYPH, paint, STATUS_GLYPH, STATUS_ROLE, stateSegments } from "./theme.js";

export interface ScheduleList {
  scheduler: SchedulerStatus;
  schedules: readonly ScheduleWithLastRun[];
}

const COLUMNS: readonly Column[] = [
  { header: "NAME", width: 14 },
  { header: "AGENT", width: 14, flex: true, min: 10 },
  { header: "CRON", width: 11, priority: 2 },
  { header: "STATE", width: 8 },
  { header: "NEXT", width: 6, align: "right" },
  { header: "LAST", width: 14 },
  { header: "LAST RUN", width: 10, priority: 3 },
  { header: "FIRE/SKIP", width: 9, align: "right", priority: 1 },
];

/** `└` lines start under AGENT (NAME never drops). */
const FOLLOW_INDENT = 16;

/** Where a paused schedule is resumed: the CLI has no resume command. */
const RESUME_HINT = "duskfleet dashboard";

/** A lease counts while it has not expired; an expired one is a holder that stopped ticking. */
function liveLease(status: SchedulerStatus, now: Date): SchedulerStatus["lease"] {
  return status.lease && new Date(status.lease.expiresAt).getTime() > now.getTime() ? status.lease : null;
}

const SEP: Segment = { text: " · ", role: null };

/** The scheduler line: one line when it fits, else holder and lease go to a second line. */
function headerLines(value: ScheduleList, opts: RenderOpts): string[] {
  const status = value.scheduler;
  const now = opts.now ?? new Date();
  const lease = liveLease(status, now);
  const pause = status.pause;
  const label = (text: string): Segment => ({ text, role: "heading" });
  const state: Segment[] = [
    label("scheduler  "),
    ...(status.enabled
      ? stateSegments(GLYPH.ok, "enabled", "ok")
      : stateSegments(GLYPH.bad, "disabled: nothing fires (scheduler.enabled is false)", "bad")),
    SEP,
    ...(lease ? stateSegments(GLYPH.run, "running", "run") : stateSegments(GLYPH.warn, "not running", "warn")),
  ];
  if (pause) {
    state.push(
      SEP,
      ...stateSegments(
        GLYPH.paused,
        `paused until ${pause.pausedUntil} (${fmtRelative(pause.pausedUntil, now)})${pause.reason ? `: ${pause.reason}` : ""}`,
        "warn",
      ),
    );
  }
  const who: Segment[] = lease
    ? [
        { text: "holder ", role: null },
        { text: lease.holder, role: null },
        SEP,
        { text: `lease ends ${fmtRelative(lease.expiresAt, now)}`, role: null },
      ]
    : [{ text: "nothing ticks: schedules fire while duskfleet serve or an MCP host runs", role: null }];
  const oneLine = [...state, SEP, ...who];
  const lines =
    // Below 100 columns, or when it does not fit, holder and lease go to a second line.
    opts.width >= 100 && oneLine.reduce((n, s) => n + s.text.length, 0) <= opts.width
      ? [paintCell(oneLine, opts)]
      : [paintCell(state, opts), paintCell([{ text: " ".repeat(11), role: null }, ...who], opts)];
  const zones = [...new Set(value.schedules.map((s) => s.timeZone))];
  if (zones.length > 0) {
    lines.push(`${paint("heading", zones.length === 1 ? "time zone" : "time zones", opts)}  ${zones.join(", ")}`);
  }
  return lines;
}

function stateCell(s: Schedule): Cell {
  return s.enabled ? stateSegments(GLYPH.ok, "on", "ok") : stateSegments(GLYPH.paused, "paused", "warn");
}

function nextCell(s: Schedule, now: Date): Cell {
  if (s.runRequestedAt) return { text: "now", role: "accent" };
  if (!s.enabled || !s.nextRunAt) return "-";
  return fmtAge(s.nextRunAt, now);
}

function lastCell(s: Schedule): Cell {
  if (!s.lastOutcome) return "-";
  return s.lastOutcome === "error" ? { text: "error", role: "bad" } : s.lastOutcome;
}

function lastRunCell(s: ScheduleWithLastRun): Cell {
  const run = s.lastRun;
  if (!run) return "-";
  const review = run.status === "completed" && run.needsReview;
  const glyph = review ? GLYPH.review : STATUS_GLYPH[run.status];
  const role = review ? "warn" : STATUS_ROLE[run.status];
  return [
    { text: glyph, role },
    { text: ` ${fmtRunCost(run.costUsd)}`, role: null },
  ];
}

export function renderSchedules(value: ScheduleList, opts: RenderOpts): string[] {
  const now = opts.now ?? new Date();
  const lines = headerLines(value, opts);
  lines.push("");
  if (value.schedules.length === 0) {
    return [...lines, ...emptyState("no schedules yet", "create one with the create_schedule MCP tool", opts)];
  }
  const rows = value.schedules.map((s): Cell[] => [
    { text: s.name, role: "accent" },
    s.agentId,
    s.cron,
    stateCell(s),
    nextCell(s, now),
    lastCell(s),
    lastRunCell(s),
    `${s.fires}/${s.skips}`,
  ]);
  const [header, ...body] = table(COLUMNS, rows, opts);
  lines.push(header!);
  body.forEach((line, i) => {
    lines.push(line);
    const s = value.schedules[i]!;
    if (!s.enabled) {
      lines.push(
        followUp(
          [
            { text: `${s.pausedReason ?? "paused by hand"} · resume: `, role: null },
            { text: RESUME_HINT, role: "accent" },
          ],
          FOLLOW_INDENT,
          opts,
        ),
      );
    }
  });
  lines.push("", jsonLine(opts, "fire one now: duskfleet schedules run-now <name>"));
  return lines;
}

/** Who fires a requested schedule: the live lease holder and the tick, or null when nothing ticks. */
export interface Ticker {
  holder: string;
  tickSeconds: number;
}

/**
 * `schedules run-now`: the confirmation line `--json` prints on stderr (plain, one line).
 * `name` is painted only when `opts.color`.
 */
export function scheduleRequestedLine(
  schedule: Pick<Schedule, "name">,
  ticker: Ticker | null,
  opts: RenderOpts,
): string {
  const name = paint("accent", `"${schedule.name}"`, opts);
  return ticker
    ? `schedule ${name} requested; ${ticker.holder} fires it within ${ticker.tickSeconds}s`
    : `schedule ${name} requested, but nothing is ticking: it fires when a scheduler starts (duskfleet serve / install-service)`;
}

/** `schedules run-now` acknowledged: a `✓` line, then who fires it or the command that starts a scheduler. */
export function renderScheduleRequested(schedule: Schedule, ticker: Ticker | null, opts: RenderOpts): string[] {
  const head = `${paint("ok", GLYPH.ok, opts)} schedule ${paint("accent", schedule.name, opts)} requested`;
  if (ticker) return [head, `  ${ticker.holder} fires it within ${ticker.tickSeconds}s`];
  return [head, `  nothing is ticking: start a scheduler with ${paint("accent", "duskfleet serve", opts)}`];
}
