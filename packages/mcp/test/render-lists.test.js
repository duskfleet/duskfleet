/**
 * The human views of `agents`, `agents create`, `projects`, `schedules`, `schedules run-now`,
 * `budgets` and `budgets set` (packages/mcp/src/render), as exact plain lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { COMMAND_HELP } from "../dist/cli-help.js";
import {
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

test("renderAgents: one row per agent, kind own / link, defaults shown as such", () => {
  assert.deepEqual(renderAgents([FIXER, REVIEWER], plain()), [
    "id        kind  source   model    project  budget  timeout  description",
    "fixer     own   user     haiku    -         $0.50      10m  Fixes the failing test",
    "reviewer  link  builtin  default  demo          -        -  -",
  ]);
});

test("renderAgents: a narrow terminal drops columns and cuts the description", () => {
  assert.deepEqual(renderAgents([FIXER, REVIEWER], plain(40)), [
    "id        kind  model    description",
    "fixer     own   haiku    Fixes the fail…",
    "reviewer  link  default  -",
  ]);
});

test("renderAgents / renderAgentCreated: a multi-line description stays on one line", () => {
  const multi = { ...FIXER, description: "Fixes the\nfailing test\n" };
  assert.deepEqual(renderAgents([multi], plain()), [
    "id     kind  source  model  project  budget  timeout  description",
    "fixer  own   user    haiku  -         $0.50      10m  Fixes the failing test",
  ]);
  const created = renderAgentCreated({ created: true, overrode: null, agent: multi }, plain());
  assert.equal(created.at(-1), "description      Fixes the failing test");
});

test("renderAgents: no agents prints nothing (the hint is on stderr)", () => {
  assert.deepEqual(renderAgents([], plain()), []);
});

test("renderAgentCreated: the agent written, and a line when it overrides a builtin", () => {
  assert.deepEqual(renderAgentCreated({ created: true, overrode: "builtin", agent: FIXER }, plain()), [
    "agent fixer created",
    'overrides the builtin agent "fixer" (same id; delete the user file to restore it)',
    "",
    "kind             own",
    "model            haiku",
    "permission mode  dontAsk",
    "allowed tools    Read, Edit",
    "budget           $0.50 per run",
    "timeout          10m",
    "description      Fixes the failing test",
  ]);
  const fresh = renderAgentCreated({ created: true, overrode: null, agent: { ...FIXER, model: undefined } }, plain());
  assert.deepEqual(fresh.slice(0, 4), [
    "agent fixer created",
    "",
    "kind             own",
    "model            default (the Claude Code default)",
  ]);
});

test("renderProjects: the allowed roots, then the projects with their bound agents", () => {
  const value = {
    allowedProjectRoots: [],
    projects: [
      { id: "demo", path: "/srv/demo" },
      { id: "side", path: "/srv/side-project" },
    ],
  };
  const agents = [{ id: "fixer" }, { id: "reviewer", project: "demo" }, { id: "helper", project: "demo" }];
  assert.deepEqual(renderProjects(value, agents, plain()), [
    "Allowed project roots",
    "  any directory",
    "",
    "id    path               agents",
    "demo  /srv/demo          reviewer, helper",
    "side  /srv/side-project  -",
  ]);
});

test("renderProjects: roots listed, and the empty state", () => {
  assert.deepEqual(renderProjects({ allowedProjectRoots: ["/srv", "/opt"], projects: [] }, [], plain()), [
    "Allowed project roots",
    "  /srv",
    "  /opt",
    "",
    "no projects registered: run --project also takes a path, or add an id to projects.yaml",
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
    timeZone: "UTC",
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

test("renderSchedules: scheduler header, then how each schedule's last run ended", () => {
  assert.deepEqual(renderSchedules({ scheduler: TICKING, schedules: SCHEDULES }, plain(160)), [
    "scheduler  enabled",
    "ticking    serve@mac:42, lease ends in 1m",
    "",
    "name       agent     cron                       state                          next    last fired        last run             fires/skips",
    "pr review  reviewer  0 9 * * * (Europe/London)  enabled                        in 21h  3h ago → started  completed ! $0.0123          5/1",
    "nightly    fixer     0 2 * * * (UTC)            paused: 3 empty runs in a row  -       -                 -                            0/0",
    "! needs review: duskfleet run-info <id>",
  ]);
});

test("renderSchedules: disabled, nothing ticking, a scheduler pause with its reason, no schedules", () => {
  const status = {
    ...TICKING,
    enabled: false,
    lease: null,
    pause: { pausedUntil: "2026-11-09T15:00:00Z", pausedAt: "2026-11-09T11:00:00Z", reason: "deploy", pausedBy: null },
  };
  assert.deepEqual(renderSchedules({ scheduler: status, schedules: [] }, plain()), [
    "scheduler  disabled: nothing fires (scheduler.enabled is false)",
    "ticking    nothing: schedules fire while duskfleet serve or an MCP host runs",
    "paused     until 2026-11-09T15:00:00Z (in 3h): deploy",
    "",
    "no schedules yet: create one with the create_schedule MCP tool",
  ]);
});

test("renderSchedules: an expired lease is nothing ticking; a requested schedule says so", () => {
  const stale = { ...TICKING, lease: { holder: "serve@mac:42", expiresAt: "2026-11-09T11:00:00Z" } };
  const requested = [{ ...SCHEDULES[0], runRequestedAt: "2026-11-09T11:59:00Z" }];
  const lines = renderSchedules({ scheduler: stale, schedules: requested }, plain(160));
  assert.equal(lines[1], "ticking    nothing: schedules fire while duskfleet serve or an MCP host runs");
  assert.match(lines[4], /enabled\s+requested\s+3h ago/);
});

test("renderScheduleRequested: one confirmation line, with or without a ticker", () => {
  assert.deepEqual(renderScheduleRequested(SCHEDULES[0], { holder: "serve@mac:42", tickSeconds: 30 }, plain()), [
    'schedule "pr review" requested; serve@mac:42 fires it within 30s',
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
  countedUsd: 3,
  percent: 30,
  state: "ok",
};

test("renderBudgets: counted against amount, state, stand-ins and the over-by-running note", () => {
  assert.deepEqual(renderBudgets([GLOBAL, AGENT, PROJECT], plain(120)), [
    "scope         counted / amount  percent  state   warn  hard stop  id        unpriced",
    "global         $12.00 / $50.00      24%  ok       80%  yes        b-global  count",
    "agent fixer      $1.40 / $1.00     140%  over *   80%  yes        b-fixer   count: $1.00 for 1 unpriced, 1 running",
    "project demo    $3.00 / $10.00      30%  ok       80%  no         b-demo    allow (2 unpriced not counted)",
    "* over only counting runs still going: new runs are refused until they end, schedules are not paused",
    "",
    "UTC month since 2026-11-01",
  ]);
});

test("renderBudgets: the empty state names the command that sets one", () => {
  assert.deepEqual(renderBudgets([], plain()), ["no budgets. Set one with:", `  ${COMMAND_HELP.budgets.example}`]);
});

test("renderBudgetSet: the budget as written, with this month's state", () => {
  assert.deepEqual(renderBudgetSet(GLOBAL, plain()), [
    "budget global set",
    "",
    "id          b-global",
    "amount      $50.00 a month (UTC)",
    "warn at     80%",
    "hard stop   yes: refuses new runs and pauses the scope's schedules",
    "unpriced    count",
    "this month  $12.00 counted, 24%",
    "state       ok",
  ]);
});

test("renderers paint only with color: true", () => {
  const colored = renderBudgets([GLOBAL], { color: true, width: 120, now }).join("\n");
  assert.ok(colored.includes("\u001b["), "colour codes with color: true");
  assert.ok(!renderBudgets([GLOBAL], plain(120)).join("\n").includes("\u001b["), "none with color: false");
});
