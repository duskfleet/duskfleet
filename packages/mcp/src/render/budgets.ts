/**
 * `duskfleet budgets` and `budgets set` for a human: one table row per monthly budget with what
 * counts against it this UTC month, and the kv block of the budget just written. Scopes are named
 * with core's `budgetLabel`, the wording every other surface uses.
 */
import { type BudgetState, type BudgetStatus, budgetLabel } from "@duskfleet/core";
import { COMMAND_HELP } from "../cli-help.js";
import { type Cell, type Column, fmtUsd, kv, type RenderOpts, table } from "./primitives.js";
import { paint, type Role } from "./theme.js";

/** Marks a budget that is over only because of the stand-ins of runs still going. */
const RUNNING_MARK = "*";

const STATE_ROLE: Readonly<Record<BudgetState, Role>> = { ok: "ok", warn: "warn", over: "bad" };

const COLUMNS: readonly Column[] = [
  { header: "scope" },
  { header: "counted / amount", align: "right" },
  { header: "percent", align: "right", priority: 5 },
  { header: "state" },
  { header: "warn", align: "right", priority: 1 },
  { header: "hard stop", priority: 3 },
  { header: "id", priority: 2 },
  { header: "unpriced", flex: true },
];

/** `count`, `count: $1.00 for 1 unpriced, 2 running`, `allow (2 unpriced not counted)`. */
function unpricedText(b: BudgetStatus): string {
  const parts = [
    b.unpricedRuns ? `${b.unpricedRuns} unpriced` : "",
    b.runningRuns ? `${b.runningRuns} running` : "",
  ].filter(Boolean);
  if (parts.length === 0) return b.unpricedPolicy;
  return b.unpricedPolicy === "allow"
    ? `allow (${parts.join(", ")} not counted)`
    : `count: ${fmtUsd(b.standInUsd)} for ${parts.join(", ")}`;
}

function stateCell(b: BudgetStatus): Cell {
  return { text: b.overByRunning ? `${b.state} ${RUNNING_MARK}` : b.state, role: STATE_ROLE[b.state] };
}

export function renderBudgets(statuses: readonly BudgetStatus[], opts: RenderOpts): string[] {
  if (statuses.length === 0) {
    return ["no budgets. Set one with:", `  ${COMMAND_HELP["budgets"]!.example}`];
  }
  const rows = statuses.map((b): Cell[] => [
    { text: budgetLabel(b), role: "accent" },
    `${fmtUsd(b.countedUsd)} / ${fmtUsd(b.amountUsd)}`,
    `${b.percent}%`,
    stateCell(b),
    `${b.warnPercent}%`,
    b.hardStop ? "yes" : { text: "no", role: "muted" },
    { text: b.id, role: "faint" },
    unpricedText(b),
  ]);
  const lines = table(COLUMNS, rows, opts);
  if (statuses.some((b) => b.overByRunning)) {
    lines.push(
      paint(
        "faint",
        `${RUNNING_MARK} over only counting runs still going: new runs are refused until they end, schedules are not paused`,
        opts,
      ),
    );
  }
  lines.push("", paint("muted", `UTC month since ${statuses[0]!.periodStart.slice(0, 10)}`, opts));
  return lines;
}

/** `budgets set`: the budget as written, with this month's state. */
export function renderBudgetSet(b: BudgetStatus, opts: RenderOpts): string[] {
  return [
    `budget ${paint("accent", budgetLabel(b), opts)} set`,
    "",
    ...kv(
      [
        ["id", b.id],
        ["amount", `${fmtUsd(b.amountUsd)} a month (UTC)`],
        ["warn at", `${b.warnPercent}%`],
        ["hard stop", b.hardStop ? "yes: refuses new runs and pauses the scope's schedules" : "no: warn only"],
        ["unpriced", unpricedText(b)],
        ["this month", `${fmtUsd(b.countedUsd)} counted, ${b.percent}%`],
        ["state", stateCell(b)],
      ],
      opts,
    ),
  ];
}
