/**
 * `duskfleet schedules` and `schedules run-now` for a human. The list opens with the scheduler's
 * state (kill switch, who ticks, a pause in force), then one table row per schedule with how its
 * last run *ended*, not only that the tick started it.
 */
import type { Schedule, SchedulerStatus, ScheduleWithLastRun } from "@duskfleet/core";
import { type Cell, type Column, fmtRelative, fmtUsd, kv, type RenderOpts, statusCell, table } from "./primitives.js";
import { REVIEW_MARK } from "./runs.js";
import { paint } from "./theme.js";

export interface ScheduleList {
  scheduler: SchedulerStatus;
  schedules: readonly ScheduleWithLastRun[];
}

const COLUMNS: readonly Column[] = [
  { header: "name" },
  { header: "agent", priority: 5 },
  { header: "cron", priority: 3 },
  { header: "state", flex: true },
  { header: "next", priority: 4 },
  { header: "last fired", priority: 2 },
  { header: "last run", priority: 6 },
  { header: "fires/skips", align: "right", priority: 1 },
];

const none: Cell = { text: "-", role: "faint" };

/** A lease counts while it has not expired; an expired one is a holder that stopped ticking. */
function liveLease(status: SchedulerStatus, now: Date): SchedulerStatus["lease"] {
  return status.lease && new Date(status.lease.expiresAt).getTime() > now.getTime() ? status.lease : null;
}

function headerLines(status: SchedulerStatus, opts: RenderOpts): string[] {
  const now = opts.now ?? new Date();
  const lease = liveLease(status, now);
  const pause = status.pause;
  return kv(
    [
      [
        "scheduler",
        status.enabled
          ? { text: "enabled", role: "ok" }
          : { text: "disabled: nothing fires (scheduler.enabled is false)", role: "bad" },
      ],
      [
        "ticking",
        lease
          ? `${lease.holder}, lease ends ${fmtRelative(lease.expiresAt, now)}`
          : { text: "nothing: schedules fire while duskfleet serve or an MCP host runs", role: "warn" },
      ],
      [
        "paused",
        pause
          ? {
              text: `until ${pause.pausedUntil} (${fmtRelative(pause.pausedUntil, now)})${pause.reason ? `: ${pause.reason}` : ""}`,
              role: "warn",
            }
          : null,
      ],
    ],
    opts,
  );
}

function stateCell(s: Schedule): Cell {
  if (s.enabled) return { text: "enabled", role: "ok" };
  return { text: s.pausedReason ? `paused: ${s.pausedReason}` : "paused", role: "warn" };
}

function nextCell(s: Schedule, now: Date): Cell {
  if (s.runRequestedAt) return { text: "requested", role: "accent" };
  if (!s.enabled || !s.nextRunAt) return none;
  return fmtRelative(s.nextRunAt, now);
}

function lastFiredCell(s: Schedule, now: Date): Cell {
  if (!s.lastFiredAt && !s.lastOutcome) return none;
  const text = `${fmtRelative(s.lastFiredAt, now)} → ${s.lastOutcome ?? "-"}`;
  return s.lastOutcome === "error" ? { text, role: "bad" } : text;
}

function lastRunCell(s: ScheduleWithLastRun): Cell {
  const run = s.lastRun;
  if (!run) return none;
  const status = statusCell(run.status);
  const text = `${status.text}${run.needsReview ? ` ${REVIEW_MARK}` : ""} ${fmtUsd(run.costUsd)}`;
  return { text, role: run.needsReview ? "warn" : status.role };
}

export function renderSchedules(value: ScheduleList, opts: RenderOpts): string[] {
  const now = opts.now ?? new Date();
  const lines = headerLines(value.scheduler, opts);
  lines.push("");
  if (value.schedules.length === 0) {
    lines.push("no schedules yet: create one with the create_schedule MCP tool");
    return lines;
  }
  const rows = value.schedules.map((s): Cell[] => [
    { text: s.name, role: "accent" },
    s.agentId,
    `${s.cron} (${s.timeZone})`,
    stateCell(s),
    nextCell(s, now),
    lastFiredCell(s, now),
    lastRunCell(s),
    `${s.fires}/${s.skips}`,
  ]);
  lines.push(...table(COLUMNS, rows, opts));
  if (value.schedules.some((s) => s.lastRun?.needsReview)) {
    lines.push(paint("faint", `${REVIEW_MARK} needs review: duskfleet run-info <id>`, opts));
  }
  return lines;
}

/** Who fires a requested schedule: the live lease holder and the tick, or null when nothing ticks. */
export interface Ticker {
  holder: string;
  tickSeconds: number;
}

/**
 * `schedules run-now`: the one confirmation line (on stdout in human mode, on stderr with `--json`).
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

export function renderScheduleRequested(schedule: Schedule, ticker: Ticker | null, opts: RenderOpts): string[] {
  return [scheduleRequestedLine(schedule, ticker, opts)];
}
