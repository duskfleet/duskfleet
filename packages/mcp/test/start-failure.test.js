/**
 * A run spawned but not marked `running` (the write failed: a locked database, typically) must
 * not become a zombie. Seen 2026-11-03: the child ran to its result while the row stayed `pending`
 * forever, because the end listener was attached after the failing write and the orphan sweep
 * leaves a live owner's rows alone. Now the listener comes first, the child is stopped and the
 * row ends `failed` with the reason.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.js";
import { ClaudeCodeExecutor, loadConfig, openDatabase, RunManager, RunRepository } from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

/**
 * A repository whose first write of `status: running` fails like a locked database: the row
 * update itself (`at: "update"`), or the status_change event written right after it, once the
 * row is already stored `running` (`at: "event"`). `armed` false lets runs through until set.
 */
class LockedOnRunning extends RunRepository {
  failed = 0;
  at = "update";
  armed = true;
  update(id, patch) {
    if (this.at === "update" && this.armed && patch.status === "running" && this.failed === 0) {
      this.failed += 1;
      throw new Error("database is locked");
    }
    super.update(id, patch);
  }
  addEvent(runId, type, payload, agentId) {
    if (
      this.at === "event" &&
      this.armed &&
      type === "status_change" &&
      payload?.to === "running" &&
      this.failed === 0
    ) {
      this.failed += 1;
      throw new Error("database is locked");
    }
    return super.addEvent(runId, type, payload, agentId);
  }
}

function makeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-start-failure-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const repo = new LockedOnRunning(db);
  const manager = new RunManager(
    config,
    repo,
    new ClaudeCodeExecutor({ binary: fakeBinary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const cleanup = async () => {
    manager.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { repo, project: realpathSync(project), manager, cleanup };
}

test("a run whose `running` write fails is stopped and ends failed with the reason, never left pending", async () => {
  const app = makeApp();
  try {
    await assert.rejects(app.manager.startRun({ prompt: "hang", projectPath: app.project }), /database is locked/);
    assert.equal(app.repo.failed, 1);
    const [row] = app.repo.listByStatus("pending").concat(app.repo.listByStatus("failed"));
    assert.ok(row, "the row was inserted before the spawn");
    const run = await app.manager.waitForRun(row.id, 10_000);
    assert.equal(run.status, "failed", "closed by the completion path, pending -> failed");
    assert.match(
      run.error,
      /could not be marked running after the spawn \(database is locked\); the process was stopped/,
    );
    assert.ok(run.endedAt, "ended");
    assert.equal(app.repo.listByStatus("pending").length, 0);
    assert.equal(app.repo.listByStatus("running").length, 0);
    assert.ok(run.reviewReasons.length > 0, "a failed run needs review");
  } finally {
    await app.cleanup();
  }
});

test("a lock on the status_change event, after the row is stored running, still ends failed with the reason", async () => {
  const app = makeApp();
  app.repo.at = "event";
  try {
    await assert.rejects(app.manager.startRun({ prompt: "hang", projectPath: app.project }), /database is locked/);
    assert.equal(app.repo.failed, 1);
    const [row] = app.repo.listByStatus("running").concat(app.repo.listByStatus("failed"));
    assert.ok(row, "the row was stored running before the event write failed");
    const run = await app.manager.waitForRun(row.id, 10_000);
    assert.equal(run.status, "failed", "running -> failed, not the cancelled outcome of the stopped child");
    assert.match(
      run.error,
      /could not be marked running after the spawn \(database is locked\); the process was stopped/,
    );
    assert.equal(app.repo.listByStatus("running").length, 0);
  } finally {
    await app.cleanup();
  }
});

test("a resume whose running write fails gives the claim back: the one retry is still available", async () => {
  const app = makeApp();
  app.repo.armed = false;
  try {
    const started = await app.manager.startRun({ prompt: "budget", projectPath: app.project });
    const first = await app.manager.waitForRun(started.id, 10_000);
    assert.equal(first.terminationReason, "budget_exhausted");

    app.repo.armed = true;
    await assert.rejects(app.manager.resumeRun({ runId: first.id }), /database is locked/);
    const [stopped] = app.repo
      .listByStatus("pending")
      .concat(app.repo.listByStatus("failed"))
      .filter((r) => r.id !== first.id);
    assert.ok(stopped, "the resume row was inserted");
    const ended = await app.manager.waitForRun(stopped.id, 10_000);
    assert.equal(ended.status, "failed");
    assert.equal(ended.resumedFromRunId, null, "claim released");
    assert.equal(app.repo.resumedBy(first.id), null);
    assert.ok(
      app.repo
        .events(stopped.id)
        .some((e) => e.type === "note" && /did not start; the retry is still available/.test(e.payload.message)),
    );

    const retry = await app.manager.resumeRun({ runId: first.id });
    assert.equal(retry.resumedFromRunId, first.id, "the next resume is not refused");
    await app.manager.waitForRun(retry.id, 10_000);
  } finally {
    await app.cleanup();
  }
});

test("the stopped run frees its agent and project; the next start goes through the usual path", async () => {
  const app = makeApp();
  try {
    await assert.rejects(app.manager.startRun({ prompt: "hang", projectPath: app.project }), /database is locked/);
    const [stopped] = app.repo.listByStatus("pending").concat(app.repo.listByStatus("failed"));
    await app.manager.waitForRun(stopped.id, 10_000);
    const started = await app.manager.startRun({ prompt: "ok", projectPath: app.project });
    const run = await app.manager.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.resultText, "Done: created hello.txt");
  } finally {
    await app.cleanup();
  }
});
