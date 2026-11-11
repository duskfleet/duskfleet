/**
 * `duskfleet budgets` and `budgets set` for a human (DS-33): the month and the unpriced policy as a
 * header, one row per monthly budget with a 10-cell meter, and a `└` line under a scope whose count
 * includes stand-ins (unpriced and running runs counted at their cap). Scopes are named with core's
 * `budgetLabel`, the wording every other surface uses.
 */
import { type BudgetState, type BudgetStatus, budgetLabel } from "@duskfleet/core";
import { COMMAND_HELP } from "../cli-help.js";
import {
  type Cell,
  type Column,
  emptyState,
  fmtCents,
  followUp,
  jsonLine,
  kv,
  type RenderOpts,
  table,
} from "./primitives.js";
import { GLYPH, paint, type StateRole, stateSegments } from "./theme.js";

const STATE: Readonly<Record<BudgetState, [string, string, StateRole]>> = {
  ok: [GLYPH.ok, "ok", "ok"],
  warn: [GLYPH.warn, "warning", "warn"],
  over: [GLYPH.bad, "stopped", "bad"],
};

const METER_CELLS = 10;

const COLUMNS: readonly Column[] = [
  { header: "SCOPE", width: 22, flex: true },
  { header: "SPENT", width: 8, align: "right" },
  { header: "LIMIT", width: 8, align: "right" },
  { header: "USED", width: 5, align: "right" },
  { header: "", width: METER_CELLS, priority: 1 },
  { header: "STATE", width: 9 },
  { header: "WARN", width: 4, align: "right", priority: 2 },
  { header: "HARD STOP", fill: true, priority: 3 },
];

/** `└` lines start under SPENT's left edge, past the scope name. */
const FOLLOW_INDENT = 2;

/** Filled cells in the state colour, empty cells dim. */
function meter(b: BudgetStatus): Cell {
  const filled = Math.max(0, Math.min(METER_CELLS, Math.round((b.percent / 100) * METER_CELLS)));
  return [
    { text: "■".repeat(filled), role: STATE[b.state][2] },
    { text: "·".repeat(METER_CELLS - filled), role: "muted" },
  ];
}

function stateCell(b: BudgetStatus): Cell {
  const [glyph, word, role] = STATE[b.state];
  return stateSegments(glyph, word, role);
}

/** `count: $1.00 for 1 unpriced, 2 running`, `allow: 2 unpriced not counted`; null when there are none. */
function standInText(b: BudgetStatus): string | null {
  const parts = [
    b.unpricedRuns ? `${b.unpricedRuns} unpriced` : "",
    b.runningRuns ? `${b.runningRuns} running` : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return b.unpricedPolicy === "allow"
    ? `allow: ${parts.join(", ")} not counted`
    : `stand-ins: ${fmtCents(b.standInUsd)} for ${parts.join(", ")}${b.overByRunning ? " · over only by running runs: schedules not paused" : ""}`;
}

export function renderBudgets(statuses: readonly BudgetStatus[], opts: RenderOpts): string[] {
  if (statuses.length === 0) return emptyState("no budgets yet", COMMAND_HELP["budgets"]!.example, opts);
  const policies = [...new Set(statuses.map((b) => b.unpricedPolicy))].join(", ");
  const lines = [
    `${paint("heading", "budgets", opts)} · UTC month since ${statuses[0]!.periodStart.slice(0, 10)} · unpriced_policy ${policies}`,
    "",
  ];
  const rows = statuses.map((b): Cell[] => [
    { text: budgetLabel(b), role: "accent" },
    fmtCents(b.countedUsd),
    fmtCents(b.amountUsd),
    `${Math.round(b.percent)}%`,
    meter(b),
    stateCell(b),
    `${b.warnPercent}%`,
    b.hardStop ? stateSegments(GLYPH.ok, "yes", "ok") : stateSegments(GLYPH.none, "no", null),
  ]);
  const [header, ...body] = table(COLUMNS, rows, opts);
  lines.push(header!);
  body.forEach((line, i) => {
    lines.push(line);
    const text = standInText(statuses[i]!);
    if (text) lines.push(followUp(text, FOLLOW_INDENT, opts));
  });
  lines.push("", jsonLine(opts, `set one: ${COMMAND_HELP["budgets"]!.example}`));
  return lines;
}

/** `budgets set`: the budget as written, with this month's state. */
export function renderBudgetSet(b: BudgetStatus, opts: RenderOpts): string[] {
  return [
    `${paint("ok", GLYPH.ok, opts)} budget ${paint("accent", budgetLabel(b), opts)} set`,
    "",
    ...kv(
      [
        ["id", { text: b.id, role: "accent" }],
        ["amount", `${fmtCents(b.amountUsd)} a month (UTC)`],
        ["warn at", `${b.warnPercent}%`],
        ["hard stop", b.hardStop ? "yes: refuses new runs and pauses the scope's schedules" : "no: warn only"],
        ["unpriced", standInText(b) ?? b.unpricedPolicy],
        ["this month", `${fmtCents(b.countedUsd)} counted, ${Math.round(b.percent)}%`],
        ["state", stateCell(b)],
      ],
      opts,
    ),
  ];
}
