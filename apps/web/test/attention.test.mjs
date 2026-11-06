import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURE_FIXES } from "@duskfleet/core";
import { attentionBadge, attentionSections, loginCode, SECTION_KINDS, summaryChips } from "../lib/attention.ts";

const NOW = Date.parse("2026-11-05T22:45:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

let n = 0;
function run(over = {}) {
  n++;
  return {
    id: `r${n}`,
    agentId: "dev",
    status: "completed",
    createdAt: ago(over.minAgo ?? 10),
    endedAt: ago(over.minAgo ?? 10),
    durationMs: 30 * 60_000,
    toolCalls: 4,
    modelUsed: "claude-sonnet-4-20250514",
    modelRequested: null,
    error: null,
    errorCode: null,
    reviewReasons: [],
    deniedTools: [],
    projectLabel: "duskfleet",
    ...over,
  };
}

function schedule(over = {}) {
  return {
    id: "s1",
    name: "nightly",
    agentId: "dev",
    enabled: true,
    pausedReason: null,
    autoPausedAt: null,
    lastOutcome: "started",
    lastError: null,
    lastFiredAt: ago(30),
    theoreticalNextAt: ago(-60),
    firings: [],
    ...over,
  };
}

function budget(over = {}) {
  return {
    id: "b1",
    scope: "global",
    scopeId: null,
    amountUsd: 50,
    warnPercent: 80,
    hardStop: true,
    countedUsd: 42.5,
    percent: 85,
    state: "warn",
    periodStart: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

const sections = (input) => attentionSections({ now: NOW, runs: [], schedules: [], budgets: [], ...input });
const kinds = (s) => s.map((x) => x.kind);

test("nothing to see: no sections, no badge", () => {
  const s = sections({ runs: [run()], schedules: [schedule()], budgets: [budget({ state: "ok", percent: 10 })] });
  assert.deepEqual(s, []);
  assert.equal(attentionBadge(s), null);
});

test("three runs failed by one auth_required are one login item, not three, and not failed runs", () => {
  const runs = [
    run({ agentId: "a", status: "failed", errorCode: "auth_required", minAgo: 5 }),
    run({ agentId: "b", status: "failed", errorCode: "auth_required", minAgo: 6 }),
    run({ agentId: "c", status: "failed", errorCode: "auth_required", minAgo: 7 }),
  ];
  const s = sections({ runs });
  assert.deepEqual(kinds(s), ["login"]);
  const [item] = s[0].items;
  assert.equal(item.runs, 3);
  assert.deepEqual(item.agents, ["a", "b", "c"]);
  assert.equal(item.title, "claude CLI · 3 agents");
  assert.equal(item.fix, FAILURE_FIXES.auth_required);
  assert.deepEqual(attentionBadge(s), { count: 1, tone: "bad" });
});

test("login clears when a later run ends without that code", () => {
  const runs = [run({ minAgo: 1 }), run({ status: "failed", errorCode: "auth_required", minAgo: 5 })];
  assert.deepEqual(sections({ runs }), []);
});

test("loginCode: auth, quota and a binary not found; other codes stay with the agent", () => {
  assert.equal(loginCode({ status: "failed", error: null, errorCode: "provider_quota" }), "provider_quota");
  assert.equal(loginCode({ status: "failed", error: "spawn claude ENOENT", errorCode: null }), "claude_not_found");
  assert.equal(loginCode({ status: "failed", error: null, errorCode: "model_not_found" }), null);
});

test("failed runs: one item per agent with the count, orphaned and timed out named, newest first", () => {
  const runs = [
    run({ agentId: "a", status: "timed_out", minAgo: 5, toolCalls: 14 }),
    run({ agentId: "b", status: "failed", error: "orphaned: its owner serve@host:1 is gone", minAgo: 6 }),
    run({ agentId: "a", status: "timed_out", minAgo: 50 }),
  ];
  const s = sections({ runs });
  assert.deepEqual(kinds(s), ["failed"]);
  const [a, b] = s[0].items;
  assert.equal(a.agentId, "a");
  assert.equal(a.badge, "Timed out ×2");
  assert.equal(a.detail, "Timed out after 30 min, 14 tool calls");
  assert.equal(b.agentId, "b");
  assert.equal(b.badge, "Orphaned");
  assert.equal(b.detail, "orphaned: its owner serve@host:1 is gone");
  assert.deepEqual(attentionBadge(s), { count: 2, tone: "warn" });
});

test("needs review: completed runs with stored reasons; a later clean run of the agent clears its items", () => {
  const denied = run({
    agentId: "p",
    reviewReasons: ["permission_denied"],
    deniedTools: [{ tool: "Bash", summary: "gh api" }],
  });
  let s = sections({ runs: [denied] });
  assert.deepEqual(kinds(s), ["review"]);
  assert.equal(s[0].items[0].badge, "Needs review");
  assert.match(s[0].items[0].detail, /permission denied \(Bash refused\)/);
  s = sections({ runs: [run({ agentId: "p", minAgo: 1 }), denied] });
  assert.deepEqual(s, []);
});

test("an agent whose schedule was paused by hand has no run items", () => {
  const runs = [run({ status: "timed_out" })];
  assert.deepEqual(sections({ runs, schedules: [schedule({ enabled: false })] }), []);
});

test("items older than 48 hours are absent", () => {
  const old = 49 * 60;
  const s = sections({
    runs: [run({ status: "timed_out", minAgo: old })],
    schedules: [schedule({ enabled: false, pausedReason: "empty runs", autoPausedAt: ago(old) })],
  });
  assert.deepEqual(s, []);
});

test("schedules: auto-paused (with a reason) and in error show; resumed or fine do not", () => {
  const s = sections({
    schedules: [
      schedule({
        id: "auto",
        agentId: "x",
        enabled: false,
        pausedReason: "The last 3 ended runs were empty",
        autoPausedAt: ago(20),
      }),
      schedule({
        id: "err",
        agentId: "y",
        lastOutcome: "error",
        lastError: "project busy\nmore",
        lastFiredAt: ago(10),
      }),
      schedule({ id: "ok", agentId: "z" }),
    ],
  });
  assert.deepEqual(kinds(s), ["schedules"]);
  assert.deepEqual(
    s[0].items.map((i) => [i.scheduleId, i.badge, i.tone, i.detail]),
    [
      ["err", "Error", "bad", "project busy"],
      ["auto", "Auto-paused", "warn", "The last 3 ended runs were empty"],
    ],
  );
});

test("budgets: at the warning amber, a spent hard stop coral (and the badge coral)", () => {
  let s = sections({ budgets: [budget()] });
  assert.equal(s[0].items[0].badge, "Budget 85 %");
  assert.equal(s[0].items[0].title, "global · November");
  assert.match(s[0].items[0].detail, /^\$42\.50 of \$50\.00 spent; warns at 80 %, hard stop at 100 %$/);
  assert.equal(attentionBadge(s).tone, "warn");
  s = sections({ budgets: [budget({ state: "over", percent: 104, countedUsd: 52 })] });
  assert.equal(s[0].items[0].tone, "bad");
  assert.equal(attentionBadge(s).tone, "bad");
});

test("skipped busy: three or more in a row count, with the streak; a fire in between breaks it", () => {
  // Newest first, as defer_busy writes them: a deferred row precedes each skipped_busy one.
  const busy = (k) =>
    Array.from({ length: k }, (_, i) => [
      { firedAt: ago(60 * i + 10), outcome: "skipped_busy" },
      { firedAt: ago(60 * i + 40), outcome: "deferred" },
    ]).flat();
  let s = sections({ schedules: [schedule({ firings: [...busy(6), { firedAt: ago(500), outcome: "started" }] })] });
  assert.deepEqual(kinds(s), ["busy"]);
  assert.equal(s[0].items[0].badge, "Skipped busy ×6");
  assert.equal(s[0].items[0].at, ago(10));
  s = sections({ schedules: [schedule({ firings: [{ firedAt: ago(5), outcome: "deferred" }, ...busy(3)] })] });
  assert.equal(s[0].items[0].badge, "Skipped busy ×3");
  assert.equal(s[0].items[0].at, ago(10));
  s = sections({ schedules: [schedule({ firings: [{ firedAt: ago(5), outcome: "started" }, ...busy(5)] })] });
  assert.deepEqual(s, []);
  s = sections({ schedules: [schedule({ firings: busy(2) })] });
  assert.deepEqual(s, []);
});

test("sections keep the fixed order and the chips name each one", () => {
  const s = sections({
    runs: [
      run({ agentId: "q", status: "failed", errorCode: "provider_quota", minAgo: 1 }),
      run({ agentId: "t", status: "timed_out", minAgo: 2 }),
      run({ agentId: "r", reviewReasons: ["empty_run"], minAgo: 3 }),
    ],
    schedules: [
      schedule({ id: "p", agentId: "p", enabled: false, pausedReason: "review", autoPausedAt: ago(4) }),
      schedule({
        id: "b",
        agentId: "b",
        firings: [1, 2, 3].map((i) => ({ firedAt: ago(i), outcome: "skipped_busy" })),
      }),
    ],
    budgets: [budget()],
  });
  assert.deepEqual(kinds(s), [...SECTION_KINDS]);
  assert.deepEqual(
    summaryChips(s).map((c) => [c.label, c.tone]),
    [
      ["1 login error", "bad"],
      ["1 failed run", "bad"],
      ["1 needs review", "warn"],
      ["1 schedule paused", "warn"],
      ["1 budget warning", "warn"],
      ["1 skipped busy", "neutral"],
    ],
  );
  assert.deepEqual(attentionBadge(s), { count: 6, tone: "bad" });
});
