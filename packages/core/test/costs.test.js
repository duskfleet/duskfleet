// costSeries (the dashboard's /costs) on a seeded DB, and the budget overlay's scope rule.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { budgetForScope, costSeries, openDatabase } from "@duskfleet/core";

// Wednesday 14 Oct 2026, noon UTC.
const NOW = new Date("2026-10-14T12:00:00.000Z");

function seeded(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), "df-costs-"));
  const db = openDatabase(dir);
  const insert = db.prepare(
    `INSERT INTO runs (id, agent_id, project_path, prompt, status, created_at, permission_mode, command_json,
       kind, cost_usd, model_requested, model_used)
     VALUES (?, ?, ?, 'x', ?, ?, 'dontAsk', '[]', ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.id,
      r.agent ?? "a",
      r.project ?? "/p",
      r.status ?? "completed",
      r.at,
      r.kind ?? "run",
      r.cost ?? null,
      r.requested ?? null,
      r.used ?? null,
    );
  }
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const RUNS = [
  { id: "a-oct", agent: "a", at: "2026-10-01T00:00:00.000Z", cost: 2, used: "claude-haiku-5-5" },
  { id: "a-sep", agent: "a", at: "2026-09-30T23:59:59.999Z", cost: 1, used: "claude-haiku-5-5" },
  { id: "b-oct", agent: "b", project: "/q", at: "2026-10-10T08:00:00.000Z", cost: 5, used: "mixed", requested: "opus" },
  { id: "b-free", agent: "b", project: "/q", at: "2026-10-11T08:00:00.000Z", cost: 0 },
  { id: "running", agent: "c", status: "running", at: "2026-10-14T11:00:00.000Z" },
  { id: "gate", agent: "g", kind: "gate", at: "2026-10-12T08:00:00.000Z", cost: 0.5 },
  { id: "old", agent: "a", at: "2025-10-31T23:00:00.000Z", cost: 100 },
];

test("costSeries stacks real-run spend per UTC month by agent, gates apart", () => {
  const { db, cleanup } = seeded(RUNS);
  try {
    const s = costSeries(db, { range: "1y", by: "agent", now: NOW });
    assert.equal(s.bucket, "month");
    assert.equal(s.starts.length, 12);
    assert.deepEqual(
      s.series.map((x) => [x.key, x.total]),
      [
        ["b", 5],
        ["a", 3],
      ],
      "biggest spender first; no-cost agents and the run before the period are left out",
    );
    assert.equal(s.series[1]?.values.at(-1), 2);
    assert.equal(s.series[1]?.values.at(-2), 1, "the last millisecond of September is September");
    assert.equal(s.totals.at(-1), 7);
    assert.equal(s.gates.at(-1), 0.5);
    assert.equal(s.gateTotal, 0.5);
    assert.equal(s.total, 8, "gates are not in the total of the bars");
    assert.equal(s.runs.at(-1), 4, "real runs started in October, free and running ones included");
    assert.equal(s.runCount, 5);
  } finally {
    cleanup();
  }
});

test("costSeries splits by project and model, and keeps the filter", () => {
  const { db, cleanup } = seeded(RUNS);
  try {
    const byProject = costSeries(db, { range: "1y", by: "project", now: NOW });
    assert.deepEqual(
      byProject.series.map((x) => x.key),
      ["/q", "/p"],
    );
    const byModel = costSeries(db, { range: "1y", by: "model", now: NOW });
    assert.deepEqual(
      byModel.series.map((x) => [x.key, x.total]),
      [
        ["opus", 5],
        ["claude-haiku-5-5", 3],
      ],
      "a mixed run counts under the model it asked for",
    );
    const one = costSeries(db, { range: "1m", by: "agent", agentId: "a", now: NOW });
    assert.equal(one.bucket, "day");
    assert.deepEqual(
      one.series.map((x) => x.key),
      ["a"],
    );
    assert.equal(one.total, 3);
    assert.equal(one.gateTotal, 0);
    const project = costSeries(db, { range: "1y", by: "agent", projectPath: "/q", now: NOW });
    assert.equal(project.total, 5);
  } finally {
    cleanup();
  }
});

test("budgetForScope: global unfiltered, the agent's or project's when filtered, never a fallback", () => {
  const budgets = [
    { id: "g", scope: "global", scopeId: null },
    { id: "ag", scope: "agent", scopeId: "a" },
    { id: "pr", scope: "project", scopeId: "web" },
  ];
  assert.equal(budgetForScope(budgets, {})?.id, "g");
  assert.equal(budgetForScope(budgets, { agentId: "a" })?.id, "ag");
  assert.equal(budgetForScope(budgets, { projectId: "web" })?.id, "pr");
  assert.equal(budgetForScope(budgets, { agentId: "a", projectId: "web" })?.id, "ag", "the agent's first");
  assert.equal(budgetForScope(budgets, { agentId: "z", projectId: "web" })?.id, "pr");
  assert.equal(budgetForScope(budgets, { agentId: "z" }), null, "a filtered view without its budget has no overlay");
  assert.equal(budgetForScope([], {}), null);
});
