import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ACTIVE_SQL, isActiveRun } from "../lib/running.ts";

test("isActiveRun: running and pending are running now, ended runs are not", () => {
  for (const status of ["running", "pending"]) assert.equal(isActiveRun({ status }), true, status);
  for (const status of ["completed", "failed", "cancelled", "timed_out"]) {
    assert.equal(isActiveRun({ status }), false, status);
  }
});

test("one running run and three pending rows: the Agents page and the Runs page count the same", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id TEXT, agent_id TEXT, kind TEXT, status TEXT)");
  const rows = [
    ["r1", "back-end", "run", "running"],
    ["r2", "ui", "run", "pending"],
    ["r3", "designer", "run", "pending"],
    ["r4", "planner", "run", "pending"],
    ["r5", "reviewer", "run", "completed"],
    ["r6", "reviewer", "run", "failed"],
  ];
  const insert = db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?)");
  for (const r of rows) insert.run(...r);

  // Agents page: agents whose agentStats row has running > 0.
  const perAgent = db.prepare(`SELECT agent_id, SUM(${ACTIVE_SQL}) AS running FROM runs GROUP BY agent_id`).all();
  const agentsRunning = perAgent.filter((r) => r.running > 0).length;
  // Runs page: the overview count and the Running list (activeRuns, filtered in memory here).
  const { running } = db.prepare(`SELECT SUM(kind = 'run' AND ${ACTIVE_SQL}) AS running FROM runs`).get();
  const listed = rows.filter(([, , , status]) => isActiveRun({ status })).length;

  assert.equal(agentsRunning, 4);
  assert.equal(running, 4);
  assert.equal(listed, 4);
  db.close();
});
