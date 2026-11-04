import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunTable } from "../../components/RunTable";
import type { RunWithProject } from "../../lib/data";

const HOUR = 3_600_000;

/** A finished, clean run; each test overrides what its state needs. */
function run(over: Partial<RunWithProject> = {}): RunWithProject {
  const ended = new Date(Date.now() - HOUR);
  return {
    id: "r1",
    agentId: "df-ui-developer",
    projectPath: "/work/demo",
    projectId: "demo",
    projectLabel: "demo",
    prompt: "Fix the agents table\n\nmore detail",
    modelRequested: "haiku",
    modelUsed: "claude-haiku-4-5-20251001",
    status: "completed",
    createdAt: new Date(ended.getTime() - 120_000).toISOString(),
    startedAt: new Date(ended.getTime() - 95_000).toISOString(),
    endedAt: ended.toISOString(),
    durationMs: 95_000,
    claudeSessionId: null,
    permissionMode: "dontAsk",
    command: { binary: "claude", argv: [], cwd: "/work/demo" },
    exitCode: 0,
    terminationReason: null,
    error: null,
    resultText: null,
    numTurns: 12,
    toolCalls: 30,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    usageByModel: null,
    costUsd: 0.0421,
    permissionDenials: 0,
    deniedTools: [],
    mcp: { mounted: [], used: [], allowListedMissing: [] },
    humanIntervention: false,
    contextExhausted: false,
    errorCode: null,
    errorFamily: null,
    errorDetail: null,
    retries: 0,
    logPath: null,
    rawResultJson: null,
    scheduleId: null,
    owner: null,
    phases: [],
    reviewReasons: [],
    resumedFromRunId: null,
    continuedFromRunId: null,
    kind: "run",
    billingType: "subscription",
    agentHash: null,
    claudeCodeVersion: null,
    lastEventAt: null,
    resumedByRunId: null,
    ...over,
  };
}

/** The text of every flag in the row (the small pills after agent · project). */
function flags(html: string): string[] {
  return [...html.matchAll(/class="flag [^"]*"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
}

function headers(html: string): string[] {
  return [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
}

test("RunTable: no runs, the empty text alone", () => {
  assert.equal(
    renderToStaticMarkup(<RunTable runs={[]} emptyText="No run yet." />),
    '<div class="empty">No run yet.</div>',
  );
});

test("RunTable: live columns, Elapsed and Started (relative)", () => {
  // Minutes, not hours: "n h ago" turns into "yesterday …" just after midnight.
  const started = new Date(Date.now() - 10 * 60_000).toISOString();
  const html = renderToStaticMarkup(<RunTable runs={[run({ startedAt: started })]} emptyText="" />);
  assert.deepEqual(headers(html), ["Status", "Run", "Model", "Elapsed", "Turns", "API value", "Started"]);
  assert.match(html, /<td class="when col-started" title="[^"]+">10 min ago<\/td>/);
});

test("RunTable: ended columns, Duration and Ended (wall clock)", () => {
  const html = renderToStaticMarkup(<RunTable runs={[run()]} emptyText="" ended />);
  assert.deepEqual(headers(html), ["Status", "Run", "Model", "Duration", "Turns", "API value", "Ended"]);
  // The clock is in the machine's locale (10:10 PM, 22:10): only its shape is pinned.
  assert.match(html, /<td class="when col-started" title="[^"]+">[^<]*\d:\d{2}[^<]*<\/td>/);
  assert.doesNotMatch(html, / ago</);
});

test("RunTable: a clean row, badge, title link, agent and project, model, duration, turns, cost", () => {
  const html = renderToStaticMarkup(<RunTable runs={[run()]} emptyText="" ended />);
  assert.match(html, /<tr class="clickable" tabindex="0">/);
  assert.match(html, /<span class="badge completed" title="completed">completed<\/span>/);
  assert.match(
    html,
    /<div class="prompt" title="Fix the agents table\n\nmore detail"><a href="\/runs\/r1">Fix the agents table<\/a><\/div>/,
  );
  assert.match(
    html,
    /<a href="\/\?agent=df-ui-developer">df-ui-developer<\/a><span class="sep">·<\/span><span title="\/work\/demo">demo<\/span>/,
  );
  assert.match(html, /<span class="pill model" title="claude-haiku-4-5-20251001">haiku 4.5<\/span>/);
  assert.match(html, /<td class="num col-duration">1m 35s<\/td><td class="num col-turns">12<\/td>/);
  assert.match(html, /<td class="num" title="[^"]*">\$0\.042<\/td>/);
  assert.deepEqual(flags(html), []);
});

test("RunTable: a running row, no cost yet, now in the ended table, the elapsed time so far", () => {
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const r = run({ status: "running", startedAt, endedAt: null, durationMs: null, costUsd: null });
  const ended = renderToStaticMarkup(<RunTable runs={[r]} emptyText="" ended />);
  assert.match(ended, /<span class="badge running" title="running">running<\/span>/);
  assert.match(ended, /<td class="num" title="[^"]*">–<\/td>/);
  assert.match(ended, /title="[^"]+">now<\/td>/);
  assert.match(ended, /<td class="num col-duration">3\ds<\/td>/);
});

test("RunTable: a silent running run is flagged, amber then red", () => {
  const since = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const quiet = run({ status: "running", startedAt: since(30), lastEventAt: since(6), endedAt: null });
  assert.match(
    renderToStaticMarkup(<RunTable runs={[quiet]} emptyText="" />),
    /class="flag warn" title="No stream-json output since [^"]+">no output for 6 min</,
  );
  const dead = run({ status: "running", startedAt: since(30), lastEventAt: since(20), endedAt: null });
  assert.match(
    renderToStaticMarkup(<RunTable runs={[dead]} emptyText="" />),
    /class="flag bad" title="[^"]+">no output for 20 min</,
  );
});

test("RunTable: review flags, each a link to the run's issues", () => {
  const r = run({
    reviewReasons: ["permission_denied", "mcp_missing", "context_exhausted"],
    permissionDenials: 2,
    deniedTools: [
      { tool: "Bash", summary: "rm -rf build" },
      { tool: "Write", summary: null },
    ],
    mcp: { mounted: [], used: [], allowListedMissing: ["mcp__claude_ai_Figma"] },
    contextExhausted: true,
  });
  const html = renderToStaticMarkup(<RunTable runs={[r]} emptyText="" />);
  assert.deepEqual(flags(html), ["2 denials", "mcp mismatch", "context exhausted"]);
  assert.match(
    html,
    /<span class="badge attention" title="completed · needs review: permission denied · allow-listed MCP server not mounted · context exhausted">needs review<\/span>/,
  );
  assert.match(
    html,
    /<a href="\/runs\/r1#issues" class="flag warn badge-link" title="Bash: rm -rf build\nWrite">2 denials<\/a>/,
  );
  assert.match(html, /title="Allow-listed but never mounted: mcp__claude_ai_Figma">mcp mismatch</);
  assert.match(html, /<a href="\/runs\/r1#issues" class="flag bad badge-link">context exhausted<\/a>/);
  const one = renderToStaticMarkup(<RunTable runs={[run({ permissionDenials: 1 })]} emptyText="" />);
  assert.deepEqual(flags(one), ["1 denial"]);
  assert.match(one, /title="A tool call was denied">1 denial</);
});

test("RunTable: budget exhausted, with or without a wrap-up pass; no extra error flag", () => {
  const base = { status: "failed" as const, error: "budget", reviewReasons: ["budget_exhausted" as const] };
  const bare = renderToStaticMarkup(<RunTable runs={[run(base)]} emptyText="" />);
  assert.deepEqual(flags(bare), ["budget exhausted"]);
  assert.match(bare, /title="The run ran out of budget mid-action and left no wrap-up trace">budget exhausted</);
  const wrapUp = {
    phase: "wrap_up" as const,
    startedAt: "",
    endedAt: "",
    durationMs: 0,
    outcome: "completed" as const,
    terminationReason: null,
    budgetUsd: 0.5,
    costUsd: 0.1,
    numTurns: 1,
    toolCalls: 0,
  };
  const wrapped = renderToStaticMarkup(<RunTable runs={[run({ ...base, phases: [wrapUp] })]} emptyText="" />);
  assert.deepEqual(flags(wrapped), ["budget exhausted · wrapped up"]);
});

test("RunTable: orphaned and plain error runs, red, the error text in the title", () => {
  const orphan = run({ status: "failed", error: "owner gone", reviewReasons: ["orphaned"] });
  const html = renderToStaticMarkup(<RunTable runs={[orphan]} emptyText="" />);
  assert.deepEqual(flags(html), ["orphaned"]);
  assert.match(html, /class="flag bad badge-link" title="owner gone">orphaned</);
  const failed = run({ status: "failed", error: "exit 1", reviewReasons: ["failed"] });
  assert.deepEqual(flags(renderToStaticMarkup(<RunTable runs={[failed]} emptyText="" />)), ["error"]);
  // A completed run's error text is not an error flag.
  assert.deepEqual(flags(renderToStaticMarkup(<RunTable runs={[run({ error: "noise" })]} emptyText="" />)), []);
});

test("RunTable: scheduled, gate and retry links", () => {
  const r = run({ scheduleId: "s1", kind: "gate", resumedFromRunId: "r0", resumedByRunId: "r2" });
  const html = renderToStaticMarkup(<RunTable runs={[r]} emptyText="" />);
  assert.deepEqual(flags(html), ["scheduled", "gate", "resumes ↗", "retried ↗"]);
  assert.match(html, /<a href="\/schedules#s1" class="flag quiet badge-link" title="s1">scheduled<\/a>/);
  assert.match(
    html,
    /<a href="\/runs\/r0" class="flag warn badge-link" title="Retry: this run resumed the session of run r0/,
  );
  assert.match(
    html,
    /<a href="\/runs\/r2" class="flag warn badge-link" title="This run&#x27;s session was resumed by run r2/,
  );
});

test("RunTable: the cost column says what the costs are, billed, API value or both", () => {
  const api = run({ billingType: "api" });
  assert.equal(headers(renderToStaticMarkup(<RunTable runs={[api]} emptyText="" />))[5], "Cost");
  const mixed = renderToStaticMarkup(<RunTable runs={[api, run({ id: "r2" })]} emptyText="" />);
  assert.equal(headers(mixed)[5], "Cost / API value");
  assert.match(
    renderToStaticMarkup(<RunTable runs={[run({ modelUsed: null, modelRequested: null })]} emptyText="" />),
    /<span class="pill model" title="CLI default">default<\/span>/,
  );
});
