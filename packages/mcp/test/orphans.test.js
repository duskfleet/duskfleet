/**
 * Orphan recovery with several DuskFleet processes on one database: a run is failed
 * only when its owning process is gone (dead pid on this host, or no owner recorded),
 * at startup and by the scheduler lease holder's periodic sweep.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeExecutor, RunManager, RunRepository, ScheduleRepository, Scheduler, formatHolder, loadConfig, openDatabase } from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

function makeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-orphans-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nscheduler:\n  enabled: true\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const repo = new RunRepository(db);
  const manager = (owner) =>
    new RunManager(config, repo, new ClaudeCodeExecutor({ binary: fakeBinary, strictMcpConfig: true, allowBypassPermissions: false }), owner ? { owner } : {});
  const a = manager(); // this test process, alive
  const cleanup = async () => {
    a.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { config, db, repo, project: realpathSync(project), a, manager, cleanup };
}

/** A pid that existed a moment ago and is gone now. */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid;
}

/** A finished run turned back into a `running` row with the given owner. */
async function runningRow(app, owner) {
  const started = await app.a.startRun({ prompt: "ok", projectPath: app.project });
  await app.a.waitForRun(started.id, 10_000);
  app.db.prepare("UPDATE runs SET status = 'running', ended_at = NULL, error = NULL, owner = ? WHERE id = ?").run(owner, started.id);
  return started.id;
}

test("a second process's startup recovery leaves a live owner's run alone; the owner completes it", async () => {
  const app = makeApp();
  try {
    const started = await app.a.startRun({ prompt: "ok", projectPath: app.project });
    assert.equal(started.owner, app.a.owner);
    assert.match(started.owner, new RegExp(`^unknown@${hostname()}:${process.pid}$`));

    const b = app.manager(formatHolder("mcp", hostname(), deadPid()));
    assert.equal(b.recoverOrphans(), 0, "owner pid is alive");
    assert.equal(b.getRun(started.id).status, "running");

    const run = await app.a.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.costUsd, 0.0123);
    assert.equal(run.resultText, "Done: created hello.txt");
  } finally {
    await app.cleanup();
  }
});

test("startup recovery fails runs of a dead owner and legacy rows, not runs of another host", async () => {
  const app = makeApp();
  try {
    const dead = formatHolder("serve", hostname(), deadPid());
    const deadRun = await runningRow(app, dead);
    const legacyRun = await runningRow(app, null);
    const remoteRun = await runningRow(app, formatHolder("serve", "some-other-host", 1));

    const b = app.manager(formatHolder("cli", hostname(), deadPid()));
    assert.equal(b.recoverOrphans(), 2);
    const failed = b.getRun(deadRun);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, `orphaned: owning process ${dead} is gone`);
    assert.ok(failed.endedAt);
    assert.equal(b.getRun(legacyRun).status, "failed", "owner NULL is recovered as before");
    assert.equal(b.getRun(remoteRun).status, "running", "another host's pids cannot be checked from here");
  } finally {
    await app.cleanup();
  }
});

test("the scheduler lease holder sweeps orphans on its tick, at most once a minute", async () => {
  const app = makeApp();
  try {
    let now = new Date("2026-10-16T10:00:00Z");
    const scheduler = new Scheduler(new ScheduleRepository(app.db), app.a, { tickMs: 1000, holder: app.a.owner, now: () => now });

    const first = await runningRow(app, formatHolder("serve", hostname(), deadPid()));
    await scheduler.tick();
    assert.equal(app.a.getRun(first).status, "failed", "swept on the first tick");

    const second = await runningRow(app, formatHolder("serve", hostname(), deadPid()));
    now = new Date("2026-10-16T10:00:30Z");
    await scheduler.tick();
    assert.equal(app.a.getRun(second).status, "running", "30 s later: no sweep yet");
    now = new Date("2026-10-16T10:01:00Z");
    await scheduler.tick();
    assert.equal(app.a.getRun(second).status, "failed", "a minute later: swept");

    // The holder's own live run is never swept.
    const live = await app.a.startRun({ prompt: "hang", projectPath: app.project });
    now = new Date("2026-10-16T10:02:00Z");
    await scheduler.tick();
    assert.equal(app.a.getRun(live.id).status, "running");
    app.a.cancelRun(live.id);
    assert.equal((await app.a.waitForRun(live.id, 10_000)).status, "cancelled");
    scheduler.stop();
  } finally {
    await app.cleanup();
  }
});
