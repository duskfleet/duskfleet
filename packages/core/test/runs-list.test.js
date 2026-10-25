// RunRepository.list outcome / reason filters (the dashboard's ?outcome= and ?reason=) on a seeded DB.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDatabase, RUN_OUTCOMES, RunRepository } from "@duskfleet/core";

function seeded() {
  const dir = mkdtempSync(path.join(tmpdir(), "df-runs-list-"));
  const db = openDatabase(dir);
  const insert = db.prepare(
    `INSERT INTO runs (id, agent_id, project_path, prompt, status, created_at, permission_mode, command_json,
       review_reasons_json, kind)
     VALUES (?, 'a', '/p', 'x', ?, ?, 'dontAsk', '[]', ?, ?)`,
  );
  const rows = [
    ["clean", "completed", null, "run"],
    ["clean-empty-array", "completed", "[]", "run"],
    ["denied", "completed", '["permission_denied"]', "run"],
    ["denied-empty", "completed", '["permission_denied","empty_run"]', "run"],
    ["timed-out", "timed_out", '["timed_out"]', "run"],
    ["cancelled", "cancelled", null, "run"],
    ["running", "running", null, "run"],
    ["gate-denied", "completed", '["permission_denied"]', "gate"],
  ];
  rows.forEach(([id, status, reasons, kind], i) => {
    insert.run(id, status, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), reasons, kind);
  });
  return {
    runs: new RunRepository(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ids = (list) => list.map((r) => r.id).sort();

test("outcome filter splits finished runs by the stored review verdict", () => {
  const { runs, cleanup } = seeded();
  try {
    assert.deepEqual(RUN_OUTCOMES, ["needs_review", "clean", "completed_review", "failed"]);
    assert.deepEqual(ids(runs.list({ outcome: "needs_review", kind: "run", limit: 200 })), [
      "denied",
      "denied-empty",
      "timed-out",
    ]);
    assert.deepEqual(ids(runs.list({ outcome: "clean", limit: 200 })), ["clean", "clean-empty-array"]);
    assert.deepEqual(ids(runs.list({ outcome: "completed_review", kind: "run", limit: 200 })), [
      "denied",
      "denied-empty",
    ]);
    assert.deepEqual(ids(runs.list({ outcome: "failed", limit: 200 })), ["cancelled", "timed-out"]);
  } finally {
    cleanup();
  }
});

test("reason filter matches one stored review reason, alone or with an outcome", () => {
  const { runs, cleanup } = seeded();
  try {
    assert.deepEqual(ids(runs.list({ reason: "permission_denied", limit: 200 })), [
      "denied",
      "denied-empty",
      "gate-denied",
    ]);
    assert.deepEqual(ids(runs.list({ reason: "empty_run", outcome: "needs_review", limit: 200 })), ["denied-empty"]);
    assert.deepEqual(ids(runs.list({ reason: "timed_out", outcome: "completed_review", limit: 200 })), []);
    assert.deepEqual(ids(runs.list({ reason: "orphaned", limit: 200 })), []);
  } finally {
    cleanup();
  }
});
