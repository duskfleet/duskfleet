/**
 * The pre-rename database (gabfactory.db) is adopted on first open so an existing
 * installation keeps its runs after the DuskFleet rename.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

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
