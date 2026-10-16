/**
 * The pre-rename database (gabfactory.db) is adopted on first open so an existing
 * installation keeps its runs after the DuskFleet rename.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@duskfleet/core";

test("a legacy gabfactory.db is renamed to duskfleet.db on first open, with its WAL files", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "duskfleet-legacy-"));
  const legacy = new DatabaseSync(path.join(dataDir, "gabfactory.db"));
  legacy.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY); INSERT INTO marker (id) VALUES (42);");
  legacy.close();
  writeFileSync(path.join(dataDir, "gabfactory.db-wal"), "");

  const db = openDatabase(dataDir);
  const row = db.prepare("SELECT id FROM marker").get();
  db.close();

  assert.equal(row.id, 42, "data from the legacy file is visible through the new name");
  assert.ok(existsSync(path.join(dataDir, "duskfleet.db")));
  assert.ok(!existsSync(path.join(dataDir, "gabfactory.db")));
  assert.ok(!existsSync(path.join(dataDir, "gabfactory.db-wal")));
  rmSync(dataDir, { recursive: true, force: true });
});

test("an existing duskfleet.db wins over a leftover legacy file", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "duskfleet-legacy-"));
  const current = new DatabaseSync(path.join(dataDir, "duskfleet.db"));
  current.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY); INSERT INTO marker (id) VALUES (1);");
  current.close();
  writeFileSync(path.join(dataDir, "gabfactory.db"), "");

  const db = openDatabase(dataDir);
  const row = db.prepare("SELECT id FROM marker").get();
  db.close();

  assert.equal(row.id, 1);
  assert.ok(existsSync(path.join(dataDir, "gabfactory.db")), "the legacy file is left untouched");
  rmSync(dataDir, { recursive: true, force: true });
});

test("migration 8 backfills review reasons for finished runs recorded before it", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "duskfleet-migrate-"));
  const first = openDatabase(dataDir);
  const insert = first.prepare(
    `INSERT INTO runs (id, agent_id, project_path, prompt, status, created_at, permission_mode, command_json, exit_code, termination_reason, error, permission_denials, human_intervention, context_exhausted, mcp_json)
     VALUES (?, 'a', '/p', 'x', ?, '2026-10-14T00:00:00Z', 'default', '{}', ?, ?, ?, ?, ?, 0, COALESCE(?, '{}'))`,
  );
  insert.run("budget", "failed", 1, "budget_exhausted", null, 0, 0, '{"mounted":[],"used":[],"allowListedMissing":[]}');
  insert.run("orphan", "failed", null, null, "orphaned: DuskFleet restarted while this run was in progress", 0, 0, null);
  insert.run("denied", "completed", 0, "completed", null, 2, 1, "not json at all");
  insert.run("cancelled", "cancelled", 1, "budget_exhausted", null, 0, 0, null);
  insert.run("running", "running", null, null, null, 0, 0, null);
  insert.run("clean", "completed", 0, "completed", null, 0, 0, '{"mounted":[],"used":[],"allowListedMissing":[]}');
  // Pretend these rows predate the migration.
  first.exec("ALTER TABLE runs DROP COLUMN review_reasons_json; DELETE FROM schema_migrations WHERE version = 8;");
  first.close();

  const db = openDatabase(dataDir);
  const reasons = Object.fromEntries(db.prepare("SELECT id, review_reasons_json FROM runs").all().map((r) => [r.id, r.review_reasons_json]));
  db.close();
  assert.deepEqual(reasons, {
    budget: '["budget_exhausted","nonzero_exit"]',
    orphan: '["orphaned"]',
    denied: '["permission_denied"]',
    cancelled: "[]",
    running: null,
    clean: "[]",
  });
  rmSync(dataDir, { recursive: true, force: true });
});
