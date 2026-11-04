/**
 * Several Duskfleet processes write one database. A write that meets another process's
 * transaction waits (PRAGMA busy_timeout) instead of failing at once with "database is locked".
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.js";
import { BUSY_TIMEOUT_MS, openDatabase } from "@duskfleet/core";

/** Another process holding a write transaction on the file for `holdMs`. Resolves once it holds it. */
function holdWriteLock(file, holdMs) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));`,
      file,
      String(holdMs),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve(child));
    child.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}

test("openDatabase sets a busy timeout, so a write waits for another process's transaction", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "duskfleet-busy-"));
  const db = openDatabase(dataDir);
  try {
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, BUSY_TIMEOUT_MS);

    const holder = await holdWriteLock(path.join(dataDir, "duskfleet.db"), 400);
    const before = Date.now();
    // Without the timeout this throws SQLITE_BUSY at once; with it, it lands once the holder commits.
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (9999, ?)").run("test");
    const waitedMs = Date.now() - before;
    assert.ok(waitedMs >= 200, `waited for the lock (${waitedMs} ms)`);
    assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version = 9999").get().version, 9999);
    await new Promise((resolve) => holder.once("exit", resolve));
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
