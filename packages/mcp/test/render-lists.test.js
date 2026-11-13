/**
 * The human views of `agents`, `agents create`, `projects`, `schedules`, `schedules run-now`,
 * `budgets` and `budgets set` (packages/mcp/src/render, DS-33), as plain lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { COMMAND_HELP } from "../dist/cli-help.js";
import {
  AGENT_CREATE,
  renderAgentCreated,
  renderAgents,
  renderBudgetSet,
  renderBudgets,
  renderProjects,
  renderScheduleRequested,
  renderSchedules,
  scheduleRequestedLine,
} from "../dist/render/index.js";

const now = new Date("2026-11-09T12:00:00Z");
const plain = (width = 100) => ({ color: false, width, now });

const FIXER = {
  id: "fixer",
  source: "user",
  name: "fixer",
  description: "Fixes the failing test",
  model: "haiku",
  permissionMode: "dontAsk",
  allowedTools: ["Read", "Edit"],
  maxBudgetUsd: 0.5,
  timeoutMinutes: 10,
  sourcePath: "/srv/data/agents/fixer.md",
};
const REVIEWER = {
  id: "reviewer",
  source: "builtin",
  name: "reviewer",
  description: "",
  permissionMode: "dontAsk",
  claudeAgent: "reviewer",
  project: "demo",
  sourcePath: "/srv/config/agents/reviewer.md",
};

test("renderAgents: ID · KIND · SOURCE · MODEL · PROJECT · BUDGET · TIMEOUT · DESCRIPTION, a link without a model reads agent", () => {
  assert.deepEqual(renderAgents([FIXER, REVIEWER], plain()), [
    "ID                    KIND  SOURCE   MODEL   PROJECT     BUDGET  TIMEOUT  DESCRIPTION",
    "fixer                 own   user     haiku   none         $0.50      10m  Fixes the failing test",
    "reviewer              link  builtin  agent   demo             -        -  -",
    "",
    `json: add --json · new agent: ${AGENT_CREATE}`,
  ]);
});

test("renderAgents: the description fills the rest of the line and is cut; a multi-line one stays on one line", () => {
  const long = { ...FIXER, description: "Fixes the\nfailing test and then writes a very long report about it" };
  const lines = renderAgents([long], plain(100));
  assert.equal(lines[1].length, 100);
  assert.ok(lines[1].endsWith("…"));
  assert.match(lines[1], / {2}Fixes the failing test/);
});

test("renderAgents: the empty state names the command that writes a first agent", () => {
  assert.deepEqual(renderAgents([], plain()), ["no agents yet", `  ${AGENT_CREATE}`]);
});

test("renderAgentCreated: a ✓ line, the run command, the file written (and what it replaced)", () => {
  assert.deepEqual(renderAgentCreated({ created: true, overrode: null, agent: FIXER }, plain()), [
    "✓ agent fixer created",
    '  duskfleet run --project <id or path> --agent fixer -- "<task>"',
    "  wrote /srv/data/agents/fixer.md",
  ]);
  const over = renderAgentCreated({ created: true, overrode: "builtin", agent: FIXER }, plain());
  assert.equal(
    over[2],
    '  wrote /srv/data/agents/fixer.md (overrides the builtin "fixer": delete this file to restore it)',
  );
  const colored = renderAgentCreated({ created: true, overrode: null, agent: FIXER }, { ...plain(), color: true });
  assert.ok(colored[0].includes("\u001b[35mfixer\u001b[39m"), "subject in magenta");
});

test("renderProjects: the allowed roots in the header, ID · PATH · AGENTS, overflow as +n", () => {
  const value = {
    allowedProjectRoots: [],
    projects: [
      { id: "demo", path: "/home/me/src/demo" },
      { id: "side", path: "/srv/side-project" },
    ],
  };
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `agent-number-${i}`, project: "demo" }));
  const lines = renderProjects(value, [{ id: "fixer" }, ...many], plain(), "/home/me");
  assert.equal(lines[0], "projects · allowed roots: any directory");
  assert.equal(lines[2], "ID            PATH                            AGENTS");
  assert.match(lines[3], /^demo {10}~\/src\/demo {22}agent-number-0, .+, \+\d+$/);
  assert.ok(lines[3].length <= 100);
  assert.equal(lines[4], "side          /srv/side-project               none");
  assert.equal(lines.at(-1), "json: add --json · register more in projects.yaml");
});

test("renderProjects: roots listed, and the empty state", () => {
  assert.deepEqual(renderProjects({ allowedProjectRoots: ["/srv", "/opt"], projects: [] }, [], plain()), [
    "projects · allowed roots: /srv, /opt",
    "",
    "no projects registered",
    "  duskfleet run --project <absolute path> ...",
  ]);
});

const TICKING = {
  enabled: true,
  running: false,
  holder: "cli@h:1",
  leaseHeldByThisProcess: false,
  lease: { holder: "serve@mac:42", expiresAt: "2026-11-09T12:01:00Z" },
  tickMs: 30_000,
  lastTickAt: null,
  pause: null,
};

const SCHEDULES = [
  {
    name: "pr review",
    agentId: "reviewer",
    cron: "0 9 * * *",
    timeZone: "Europe/London",
    enabled: true,
    pausedReason: null,
    nextRunAt: "2026-11-10T09:00:00Z",
    runRequestedAt: null,
    lastFiredAt: "2026-11-09T09:00:00Z",
    lastOutcome: "started",
    lastRun: { id: "r1", status: "completed", needsReview: true, costUsd: 0.0123 },
    fires: 5,
    skips: 1,
  },
  {
    name: "nightly",
    agentId: "fixer",
    cron: "0 2 * * *",
    timeZone: "Europe/London",
    enabled: false,
    pausedReason: "3 empty runs in a row",
    nextRunAt: "2026-11-10T02:00:00Z",
    runRequestedAt: null,
    lastFiredAt: null,
    lastOutcome: null,
    lastRun: null,
    fires: 0,
    skips: 0,
  },
];

test("renderSchedules at 100 columns: status line, time zone, every column, └ under a paused schedule", () => {
  assert.deepEqual(renderSchedules({ scheduler: TICKING, schedules: SCHEDULES }, plain()), [
    "scheduler  ✓ enabled · ● running · holder serve@mac:42 · lease ends in 1m",
    "time zone  Europe/London",
    "",
    "NAME            AGENT           CRON         STATE       NEXT  LAST            LAST RUN    FIRE/SKIP",
    "pr review       reviewer        0 9 * * *    ✓ on         21h  started         ! $0.01           5/1",
    "nightly         fixer           0 2 * * *    ‖ paused       -  -               -                 0/0",
    "                └ 3 empty runs in a row · resume: duskfleet dashboard",
    "",
    "json: add --json · fire one now: duskfleet schedules run-now <name>",
  ]);
});

test("renderSchedules at 80 columns drops FIRE/SKIP then CRON, below 70 LAST RUN; the status header wraps", () => {
  const at80 = renderSchedules({ scheduler: TICKING, schedules: SCHEDULES }, plain(80));
  assert.deepEqual(at80.slice(0, 2), [
    "scheduler  ✓ enabled · ● running",
    "           holder serve@mac:42 · lease ends in 1m",
  ]);
  assert.equal(at80[4], "NAME            AGENT           STATE       NEXT  LAST            LAST RUN");
  assert.ok(at80.every((l) => l.length <= 80));
  const at68 = renderSchedules({ scheduler: TICKING, schedules: SCHEDULES }, plain(68));
  assert.match(at68[4], /^NAME +AGENT +STATE +NEXT +LAST$/);
});

test("renderSchedules: a last run under one cent reads <$0.01, never $0.00", () => {
  const subCent = [{ ...SCHEDULES[0], lastRun: { ...SCHEDULES[0].lastRun, costUsd: 0.0038 } }];
  const lines = renderSchedules({ scheduler: TICKING, schedules: subCent }, plain());
  assert.equal(
    lines[4],
    "pr review       reviewer        0 9 * * *    ✓ on         21h  started         ! <$0.01          5/1",
  );
});

test("renderSchedules: disabled, nothing ticking, a scheduler pause with its reason, no schedules", () => {
  const status = {
    ...TICKING,
    enabled: false,
    lease: null,
    pause: { pausedUntil: "2026-11-09T15:00:00Z", pausedAt: "2026-11-09T11:00:00Z", reason: "deploy", pausedBy: null },
  };
  const lines = renderSchedules({ scheduler: status, schedules: [] }, plain(300));
  assert.equal(
    lines[0],
    "scheduler  ✗ disabled: nothing fires (scheduler.enabled is false) · ! not running · ‖ paused until 2026-11-09T15:00:00Z (in 3h): deploy · nothing ticks: schedules fire while duskfleet serve or an MCP host runs",
  );
  assert.deepEqual(lines.slice(1), ["", "no schedules yet", "  create one with the create_schedule MCP tool"]);
});

test("renderSchedules: an expired lease is nothing ticking; a requested schedule fires now", () => {
  const stale = { ...TICKING, lease: { holder: "serve@mac:42", expiresAt: "2026-11-09T11:00:00Z" } };
  const requested = [{ ...SCHEDULES[0], runRequestedAt: "2026-11-09T11:59:00Z" }];
  const lines = renderSchedules({ scheduler: stale, schedules: requested }, plain(200));
  assert.match(lines[0], /! not running · nothing ticks/);
  assert.match(lines[4], /✓ on +now {2}started/);
});

test("renderScheduleRequested: a ✓ line, then who fires it or how to start a scheduler", () => {
  assert.deepEqual(renderScheduleRequested(SCHEDULES[0], { holder: "serve@mac:42", tickSeconds: 30 }, plain()), [
    "✓ schedule pr review requested",
    "  serve@mac:42 fires it within 30s",
  ]);
  assert.deepEqual(renderScheduleRequested(SCHEDULES[0], null, plain()), [
    "✓ schedule pr review requested",
    "  nothing is ticking: start a scheduler with duskfleet serve",
  ]);
  assert.equal(
    scheduleRequestedLine(SCHEDULES[0], null, plain()),
    'schedule "pr review" requested, but nothing is ticking: it fires when a scheduler starts (duskfleet serve / install-service)',
  );
});

const BUDGET_BASE = {
  warnPercent: 80,
  hardStop: true,
  unpricedPolicy: "count",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  periodStart: "2026-11-01T00:00:00.000Z",
  unpricedRuns: 0,
  runningRuns: 0,
  standInUsd: 0,
  overByRunning: false,
};
const GLOBAL = {
  ...BUDGET_BASE,
  id: "b-global",
  scope: "global",
  scopeId: null,
  amountUsd: 50,
  spentUsd: 12,
  countedUsd: 12,
  percent: 24,
  state: "ok",
};
const AGENT = {
  ...BUDGET_BASE,
  id: "b-fixer",
  scope: "agent",
  scopeId: "fixer",
  amountUsd: 1,
  spentUsd: 0.4,
  unpricedRuns: 1,
  runningRuns: 1,
  standInUsd: 1,
  countedUsd: 1.4,
  percent: 140,
  state: "over",
  overByRunning: true,
};
const PROJECT = {
  ...BUDGET_BASE,
  id: "b-demo",
  scope: "project",
  scopeId: "demo",
  amountUsd: 10,
  hardStop: false,
  unpricedPolicy: "allow",
  spentUsd: 3,
  unpricedRuns: 2,
  countedUsd: 9,
  percent: 90,
  state: "warn",
};

test("renderBudgets: month and policy header, a meter per scope, stand-ins on └ lines", () => {
  assert.deepEqual(renderBudgets([GLOBAL, AGENT, PROJECT], plain()), [
    "budgets · UTC month since 2026-11-01 · unpriced_policy count, allow",
    "",
    "SCOPE                      SPENT     LIMIT   USED              STATE      WARN  HARD STOP",
    "global                    $12.00    $50.00    24%  ■■········  ✓ ok        80%  ✓ yes",
    "agent fixer                $1.40     $1.00   140%  ■■■■■■■■■■  ✗ stopped   80%  ✓ yes",
    "  └ stand-ins: $1.00 for 1 unpriced, 1 running · over only by running runs: schedules not paused",
    "project demo               $9.00    $10.00    90%  ■■■■■■■■■·  ! warning   80%  – no",
    "  └ allow: 2 unpriced not counted",
    "",
    `json: add --json · set one: ${COMMAND_HELP.budgets.example}`,
  ]);
});

test("renderBudgets: the empty state names the command that sets one", () => {
  assert.deepEqual(renderBudgets([], plain()), ["no budgets yet", `  ${COMMAND_HELP.budgets.example}`]);
});

test("renderBudgetSet: a ✓ line and the budget as written, with this month's state", () => {
  assert.deepEqual(renderBudgetSet(GLOBAL, plain()), [
    "✓ budget global set",
    "",
    "id          b-global",
    "amount      $50.00 a month (UTC)",
    "warn at     80%",
    "hard stop   yes: refuses new runs and pauses the scope's schedules",
    "unpriced    count",
    "this month  $12.00 counted, 24%",
    "state       ✓ ok",
  ]);
});

test("renderers paint only with color: true; the meter's empty cells are dim", () => {
  const colored = renderBudgets([GLOBAL], { color: true, width: 100, now }).join("\n");
  assert.ok(
    colored.includes("\u001b[32m■■\u001b[39m\u001b[2m········\u001b[22m"),
    "filled in the state colour, empty dim",
  );
  assert.ok(!renderBudgets([GLOBAL], plain()).join("\n").includes("\u001b["), "none with color: false");
});
