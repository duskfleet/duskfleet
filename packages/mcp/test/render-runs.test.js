/**
 * The human views of `runs`, `run` and `run-info` (packages/mcp/src/render), as exact plain lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { costTotals, costTotalsLine, FAILURE_FIXES } from "@duskfleet/core";
import { COMMAND_HELP } from "../dist/cli-help.js";
import { renderRunInfo, renderRunResult, renderRuns } from "../dist/render/index.js";

const now = new Date("2026-11-09T12:00:00Z");
const plain = (width = 100) => ({ color: false, width, now });

const SUMMARIES = [
  {
    id: "r1",
    status: "completed",
    needsReview: false,
    createdAt: "2026-11-09T11:55:00Z",
    agentId: "fixer",
    projectId: "demo",
    projectPath: "/srv/demo",
    label: "Fix the test",
    durationMs: 12_345,
    costUsd: 0.0123,
    costLabel: "Cost",
    costStatus: "reported",
  },
  {
    id: "r2",
    status: "failed",
    needsReview: true,
    createdAt: "2026-11-09T09:00:00Z",
    agentId: "fixer",
    projectId: null,
    projectPath: "/srv/app",
    label: "Do it",
    durationMs: null,
    costUsd: null,
    costLabel: "API value",
    costStatus: "unpriced",
  },
];
const TOTALS = costTotals([
  { costUsd: 0.0123, billingType: "api" },
  { costUsd: null, billingType: null },
]);

test("renderRuns: a table, a review legend and the cost total as the last line", () => {
  assert.deepEqual(renderRuns(SUMMARIES, TOTALS, plain()), [
    "when    status     id  agent  project  label         duration      cost",
    "5m ago  completed  r1  fixer  demo     Fix the test     12.3s   $0.0123",
    "3h ago  failed !   r2  fixer  app      Do it                -  unpriced",
    "! needs review: duskfleet run-info <id>",
    "",
    costTotalsLine(TOTALS),
  ]);
});

test("renderRuns: a narrow terminal drops columns, lowest priority first", () => {
  const lines = renderRuns(SUMMARIES, TOTALS, plain(40));
  assert.deepEqual(lines.slice(0, 3), [
    "status     id  agent  label",
    "completed  r1  fixer  Fix the test",
    "failed !   r2  fixer  Do it",
  ]);
});

test("renderRuns: the empty state names the command that starts a run", () => {
  assert.deepEqual(renderRuns([], null, plain()), ["no runs yet. Start one with:", `  ${COMMAND_HELP.run.example}`]);
});

const FAILED = {
  id: "r9",
  status: "failed",
  reviewReasons: ["failed"],
  durationMs: 1500,
  costUsd: 0.0123,
  billingType: "api",
  costStatus: "reported",
  errorCode: "auth_required",
  errorFamily: "setup",
  errorDetail: null,
  error: "Invalid API key · Please run /login",
  deniedTools: [],
  logPath: "/tmp/r9.jsonl",
};

test("renderRunResult: header, then cause / fix / more for a run that did not end clean, then the log", () => {
  assert.deepEqual(renderRunResult(FAILED, plain()), [
    "run r9 failed (failed) · 1.5s · $0.0123",
    "cause: Claude is not logged in: Invalid API key · Please run /login",
    `fix: ${FAILURE_FIXES.auth_required}`,
    "more: duskfleet run-info r9",
    "log: /tmp/r9.jsonl",
  ]);
});

test("renderRunResult: a clean run is the header and the log; API value costs are marked ≈", () => {
  const clean = {
    ...FAILED,
    id: "r8",
    status: "completed",
    reviewReasons: [],
    durationMs: 850,
    costUsd: 0.5,
    billingType: "subscription",
    costStatus: "estimated",
    errorCode: null,
    error: null,
    logPath: "/tmp/r8.jsonl",
  };
  assert.deepEqual(renderRunResult(clean, plain()), ["run r8 completed · 850ms · ≈$0.50", "log: /tmp/r8.jsonl"]);
  const running = { ...clean, status: "running", durationMs: null, costUsd: null, costStatus: null };
  assert.deepEqual(renderRunResult(running, plain()), ["run r8 running", "log: /tmp/r8.jsonl"]);
});

test("renderRunInfo: Run, Usage and Outcome sections; Subagents, Diff and Events only when there are some", () => {
  const run = {
    ...FAILED,
    agentId: "fixer",
    projectId: "demo",
    projectPath: "/srv/demo",
    modelUsed: "haiku",
    modelRequested: "haiku",
    claudeSessionId: "s1",
    createdAt: "2026-11-09T11:55:00Z",
    endedAt: null,
    numTurns: 3,
    toolCalls: 1200,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    terminationReason: null,
    exitCode: 1,
    phases: [],
  };
  const lines = renderRunInfo({ run, label: "Fix it", costLabel: "Cost", diff: null, subagents: [] }, plain());
  assert.deepEqual(lines, [
    "Run",
    "  id        r9",
    "  label     Fix it",
    "  status    failed needs review: failed",
    "  agent     fixer",
    "  project   demo (/srv/demo)",
    "  model     haiku",
    "  session   s1",
    "  created   2026-11-09T11:55:00Z (5m ago)",
    "  duration  1.5s",
    "  log       /tmp/r9.jsonl",
    "",
    "Usage",
    "  turns       3",
    "  tool calls  1,200",
    "  tokens      10 in, 20 out",
    "  cost        $0.0123 (reported)",
    "",
    "Outcome",
    "  exit code  1",
    "  failure    Claude is not logged in (auth_required, setup)",
    "  error      Invalid API key · Please run /login",
    `  fix        ${FAILURE_FIXES.auth_required}`,
  ]);

  const more = renderRunInfo(
    {
      run,
      label: "Fix it",
      costLabel: "Cost",
      diff: {
        base: "aaaaaaaaaa",
        head: "bbbbbbbbbb",
        additions: 3,
        deletions: 1,
        totalsPartial: false,
        filesChanged: 1,
        changedFiles: [{ path: "sum.js", status: "modified", additions: 3, deletions: 1 }],
        filesTruncated: false,
        patchPath: "/tmp/r9.diff",
        patchBytes: 10,
        patchTruncated: false,
      },
      subagents: [
        { type: "explore", status: "completed", model: null, toolCalls: 2, durationMs: 2000, description: "Look" },
      ],
      events: [],
    },
    plain(),
  );
  const tail = more.slice(more.indexOf("Subagents"));
  assert.deepEqual(tail, [
    "Subagents",
    "  type     status     model  tools  duration  description",
    "  explore  completed  -          2      2.0s  Look",
    "",
    "Diff",
    "  1 file changed, +3 -1 · aaaaaaa..bbbbbbb",
    "  modified  sum.js  +3 -1",
    "  patch: /tmp/r9.diff",
    "",
    "Events",
    "  none",
  ]);
});
