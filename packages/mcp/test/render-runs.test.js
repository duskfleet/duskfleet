/**
 * The human views of `runs`, `run` and `run-info` (packages/mcp/src/render, DS-33), as exact plain
 * lines: column order and widths, the 80-column drop order, `└` lines, footer and json line.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { FAILURE_FIXES, REVIEW_REASON_FIXES } from "@duskfleet/core";
import { COMMAND_HELP } from "../dist/cli-help.js";
import { renderRunInfo, renderRunResult, renderRuns, runReportLines } from "../dist/render/index.js";

const now = new Date("2026-11-09T12:00:00Z");
const plain = (width = 100) => ({ color: false, width, now });
const ESC = "\u001b[";

const RUN = {
  id: "1a2b3c4d-0000-4000-8000-000000000001",
  status: "completed",
  needsReview: false,
  reviewReasons: [],
  deniedTools: [],
  createdAt: "2026-11-09T11:58:00Z",
  agentId: "fixer",
  projectId: "demo",
  projectPath: "/srv/demo",
  model: "claude-haiku-4-5",
  label: "Fix the test",
  durationMs: 12_345,
  costUsd: 0.08,
  costLabel: "Cost",
  costStatus: "reported",
  toolCalls: 14,
  errorCode: null,
  errorFamily: null,
  errorDetail: null,
  terminationReason: null,
};
const SUMMARIES = [
  RUN,
  {
    ...RUN,
    id: "5e6f7a8b-0000-4000-8000-000000000002",
    needsReview: true,
    reviewReasons: ["permission_denied"],
    deniedTools: [{ tool: "Bash" }, { tool: "Bash" }, { tool: "WebFetch" }],
    createdAt: "2026-11-09T11:42:00Z",
    agentId: "a-very-long-reviewer-agent-name",
    model: "sonnet",
    costUsd: 0.21,
    costLabel: "API value",
    costStatus: "estimated",
  },
  {
    ...RUN,
    id: "9c0d1e2f-0000-4000-8000-000000000003",
    status: "failed",
    needsReview: true,
    reviewReasons: ["failed"],
    createdAt: "2026-11-07T12:00:00Z",
    projectId: null,
    projectPath: "/srv/app",
    durationMs: null,
    costUsd: null,
    costStatus: "unpriced",
    toolCalls: 0,
    errorCode: "auth_required",
    errorFamily: "setup",
  },
];

test("renderRuns at 100 columns: every column at its design width, └ lines, footer, json line", () => {
  assert.deepEqual(renderRuns(SUMMARIES, plain()), [
    "ID        STATUS          AGENT               PROJECT       MODEL      AGE  DURATION     COST  TOOLS",
    "1a2b3c4d  ✓ completed     fixer               demo          haiku       2m     12.3s    $0.08     14",
    "5e6f7a8b  ! needs review  a-very-long-revie…  demo          sonnet     18m     12.3s   ~$0.21     14",
    "          └ permission denied · 2 denied: Bash, WebFetch",
    "9c0d1e2f  ✗ failed        fixer               app           haiku       2d         -        ?      0",
    `          └ setup · ${FAILURE_FIXES.auth_required}`.slice(0, 99) + "…",
    "",
    "total $0.29 · ~ estimated · ? unpriced, not in the total (1)",
    "3 runs · newest first",
    "json: add --json · details: duskfleet run-info <id>",
  ]);
});

test("renderRuns at 80 columns drops TOOLS then PROJECT, below 72 MODEL; ID, STATUS, AGE, DURATION, COST stay", () => {
  const header = (w) => renderRuns(SUMMARIES, plain(w))[0];
  assert.equal(header(100).split(/\s+/).length, 9);
  assert.equal(
    header(93),
    "ID        STATUS          AGENT               PROJECT       MODEL      AGE  DURATION     COST",
  );
  // AGENT takes the room the dropped columns left (19 here), up to its widest cell.
  assert.equal(header(80), "ID        STATUS          AGENT                MODEL      AGE  DURATION     COST");
  assert.equal(header(70), "ID        STATUS          AGENT                 AGE  DURATION     COST");
  const at80 = renderRuns(SUMMARIES, plain(80));
  assert.equal(at80[2], "5e6f7a8b  ! needs review  a-very-long-review…  sonnet     18m     12.3s   ~$0.21");
  assert.ok(
    at80.every((l) => l.length <= 80),
    "nothing wider than the terminal",
  );
  const at60 = renderRuns(SUMMARIES, plain(60));
  assert.match(at60[2], /^5e6f7a8b {2}! needs review {2}a-very-long… {2}/, "AGENT stops at its 12-column floor");
});

test("renderRuns: runs under one cent read <$0.01 / ~<$0.01 in COST, the total sums the real values", () => {
  const subCent = [
    { ...RUN, costUsd: 0.0038, costStatus: "estimated" },
    { ...RUN, id: "5e6f7a8b-0000-4000-8000-000000000002", costUsd: 0.0099 },
    { ...RUN, id: "9c0d1e2f-0000-4000-8000-000000000003", costUsd: 0 },
  ];
  const lines = renderRuns(subCent, plain());
  assert.deepEqual(lines.slice(1, 4), [
    "1a2b3c4d  ✓ completed     fixer               demo          haiku       2m     12.3s  ~<$0.01     14",
    "5e6f7a8b  ✓ completed     fixer               demo          haiku       2m     12.3s   <$0.01     14",
    "9c0d1e2f  ✓ completed     fixer               demo          haiku       2m     12.3s    $0.00     14",
  ]);
  assert.equal(lines[5], "total $0.01 · ~ estimated");
  assert.ok(
    renderRuns(subCent, plain(80)).every((l) => l.length <= 80),
    "~<$0.01 fits the 7-column COST at 80 columns",
  );
});

test("renderRuns: a filter is named in the footer; the empty state names the command", () => {
  assert.equal(
    renderRuns([RUN], plain(), "status=completed, limit=1").at(-2),
    "1 run · newest first · filter: status=completed, limit=1",
  );
  assert.deepEqual(renderRuns([], plain()), ["no runs yet", `  ${COMMAND_HELP.run.example}`]);
});

test("renderRuns with colour: glyphs coloured, words in the default colour, failed in bright red bold", () => {
  const lines = renderRuns(SUMMARIES, { ...plain(), color: true });
  assert.ok(lines[1].includes("\u001b[32m✓\u001b[39m completed"), "green glyph, default word");
  assert.ok(lines[2].includes("\u001b[33m!\u001b[39m \u001b[1mneeds review\u001b[22m"), "yellow glyph, bold word");
  assert.ok(lines[4].includes("\u001b[91m"), "failed is bright red");
  assert.ok(lines[0].startsWith("\u001b[1mID"), "headers bold");
  assert.ok(lines[1].includes("\u001b[35m1a2b3c4d\u001b[39m"), "ids magenta");
  assert.ok(lines.at(-1).startsWith("\u001b[2mjson"), "json line dim");
  const all = lines.join("\n");
  assert.ok(!all.includes("\u001b[31m") && !all.includes("\u001b[90m"), "never red 31 or bright black 90");
  assert.ok(!renderRuns(SUMMARIES, plain()).join("\n").includes(ESC), "color: false prints no escape code");
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

test("renderRunResult: header with glyph status, then cause / fix / more for a run that did not end clean, then the log", () => {
  assert.deepEqual(renderRunResult(FAILED, plain()), [
    "run r9 ✗ failed · 1.5s · $0.01",
    "cause: Claude is not logged in: Invalid API key · Please run /login",
    `fix: ${FAILURE_FIXES.auth_required}`,
    "more: duskfleet run-info r9",
    "log: /tmp/r9.jsonl",
  ]);
  const colored = renderRunResult(FAILED, { ...plain(), color: true });
  assert.ok(colored[1].startsWith("\u001b[1mcause:\u001b[22m"), "bold labels");
  assert.ok(colored[3].includes("\u001b[35mduskfleet run-info r9\u001b[39m"), "the more command in magenta");
  assert.equal(colored.at(-1), "\u001b[2mlog: /tmp/r9.jsonl\u001b[22m", "the log line dim");
});

test("renderRunResult: a clean run is the header and the log; estimated costs read ~, a review names its reasons", () => {
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
  assert.deepEqual(renderRunResult(clean, plain()), ["run r8 ✓ completed · 850ms · ~$0.50", "log: /tmp/r8.jsonl"]);
  const running = { ...clean, status: "running", durationMs: null, costUsd: null, costStatus: null };
  assert.deepEqual(renderRunResult(running, plain()), ["run r8 ● running", "log: /tmp/r8.jsonl"]);
  const review = { ...clean, reviewReasons: ["budget_exhausted"] };
  assert.deepEqual(renderRunResult(review, plain()).slice(0, 3), [
    "run r8 ! needs review · 850ms · ~$0.50",
    "cause: budget exhausted",
    `fix: ${REVIEW_REASON_FIXES.budget_exhausted}`,
  ]);
  assert.deepEqual(runReportLines(review), [
    "run r8 completed, needs review (budget exhausted)",
    `fix: ${REVIEW_REASON_FIXES.budget_exhausted}`,
    "more: duskfleet run-info r8",
  ]);
});

const rule = (title, width = 100) => `${title} ${"─".repeat(width - title.length - 1)}`;

test("renderRunInfo: title, Run, Usage and Outcome with 14-column keys; Subagents, Diff and Events only when there are some", () => {
  const run = {
    ...FAILED,
    agentId: "fixer",
    projectId: "demo",
    projectPath: "/srv/demo",
    scheduleId: null,
    modelUsed: "haiku",
    modelRequested: "haiku",
    claudeCodeVersion: "2.1.0",
    claudeSessionId: "s1",
    createdAt: "2026-11-09T11:55:00Z",
    endedAt: null,
    numTurns: 3,
    toolCalls: 1200,
    deniedTools: [{ tool: "Bash" }],
    terminationReason: null,
    exitCode: 1,
    humanIntervention: true,
    contextExhausted: false,
    phases: [],
  };
  const info = {
    run,
    label: "Fix it",
    costLabel: "Cost",
    diff: null,
    subagents: [],
    agent: { kind: "own", source: "user" },
  };
  assert.deepEqual(renderRunInfo(info, plain()), [
    "run r9  ✗ failed",
    "",
    rule("Run"),
    "  agent         fixer (own, user)",
    "  project       demo (/srv/demo)",
    "  label         Fix it",
    "  model         haiku (claude code 2.1.0)",
    "  session       s1",
    "  created       2026-11-09 11:55:00 UTC (5m ago)",
    "  duration      1.5s",
    "",
    rule("Usage"),
    "  cost          $0.0123 (reported)",
    "  turns         3",
    "  tool calls    1,200 · denied: Bash",
    "",
    rule("Outcome"),
    "  status        ✗ failed",
    "  reasons       failed",
    "  termination   exit code 1",
    "  cause         Claude is not logged in: Invalid API key · Please run /login (auth_required, setup)",
    `  fix           ${FAILURE_FIXES.auth_required}`,
    "  human         needed: a tool was denied",
    "",
    "json: add --json · log: /tmp/r9.jsonl",
  ]);

  const more = renderRunInfo(
    {
      ...info,
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
      subagents: [{ type: "explore", status: "completed", totalTokens: 12_000, durationMs: 2000, description: "Look" }],
      events: [
        { ts: "2026-11-09T11:55:01.000Z", type: "permission_denied", agentId: null, payload: { tool: "Bash" } },
        { ts: "2026-11-09T11:55:02.000Z", type: "tool_use", agentId: null, payload: "Read sum.js" },
      ],
    },
    plain(),
  );
  const tail = more.slice(more.indexOf(rule("Subagents")));
  assert.deepEqual(tail, [
    rule("Subagents"),
    "  NAME                STATUS            TOKENS   DURATION",
    "  explore             ✓ completed       12,000       2.0s",
    "",
    rule("Diff"),
    "  1 file changed · +3 −1 · aaaaaaa..bbbbbbb",
    "  modified  sum.js  +3 −1",
    "  patch: /tmp/r9.diff",
    "",
    rule("Events"),
    '  11:55:01  permissio…  {"tool":"Bash"}',
    "  11:55:02  tool_use    Read sum.js",
    "",
    "json: add --json · log: /tmp/r9.jsonl",
  ]);
  const colored = renderRunInfo({ ...info, events: more.events ?? [] }, { ...plain(), color: true }).join("\n");
  assert.ok(colored.includes("\u001b[1mdenied: Bash\u001b[22m"), "denied tools in bold");
  assert.ok(colored.includes("\u001b[2m─"), "the section rule is dim");

  // Pre-existing changes left out, a file changed again, a worktree and a removed worktree's branch.
  const totals = { totalsPartial: false, filesTruncated: false, commitsTruncated: false };
  const withWorktrees = renderRunInfo(
    {
      ...info,
      diff: {
        base: "aaaaaaaaaa",
        head: "aaaaaaaaaa",
        additions: 1,
        deletions: 0,
        totalsPartial: false,
        filesChanged: 1,
        changedFiles: [{ path: "a.txt", status: "modified", additions: 1, deletions: 0, preexisting: true }],
        filesTruncated: false,
        patchPath: "/tmp/r9.diff",
        patchBytes: 10,
        patchTruncated: false,
        preexisting: 2,
        worktrees: [
          {
            ...totals,
            path: "/p/.claude/worktrees/issue-1",
            branch: "issue/1-x",
            removed: false,
            base: "cccccccccc",
            head: "dddddddddd",
            commits: [{ sha: "dddddddddd", subject: "feature (#1)" }],
            additions: 2,
            deletions: 0,
            filesChanged: 1,
            changedFiles: [{ path: "feature.txt", status: "added", additions: 2, deletions: 0 }],
          },
          {
            ...totals,
            path: null,
            branch: "issue/2-y",
            removed: true,
            base: "cccccccccc",
            head: "eeeeeeeeee",
            commits: [
              { sha: "eeeeeeeeee", subject: "b" },
              { sha: "ffffffffff", subject: "a" },
            ],
            additions: 1,
            deletions: 1,
            filesChanged: 1,
            changedFiles: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }],
          },
        ],
      },
    },
    plain(),
  );
  const diffLines = withWorktrees.slice(
    withWorktrees.indexOf(rule("Diff")) + 1,
    withWorktrees.indexOf(rule("Diff")) + 9,
  );
  assert.deepEqual(diffLines, [
    "  1 file changed · +1 −0 · aaaaaaa",
    "  2 files already changed before the run and left as they were: not shown",
    "  modified  a.txt  +1 −0  (also changed before the run)",
    "  worktree /p/.claude/worktrees/issue-1 (issue/1-x) · 1 file changed · +2 −0 · 1 commit · ccccccc..ddddddd",
    "    added     feature.txt  +2 −0",
    "  branch issue/2-y (worktree removed) · 1 file changed · +1 −1 · 2 commits · ccccccc..eeeeeee",
    "    modified  a.txt  +1 −1",
    "  patch: /tmp/r9.diff",
  ]);
});
