/**
 * Grace kill after the result line (#44): a child that keeps running after printing its
 * result, or exits while a descendant (a user-level Stop hook) holds its stdout open, is
 * ended by signalling its process group; the run keeps the result's verdict and records a note.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import { ClaudeCodeExecutor, loadConfig, openDatabase, RunManager, RunRepository } from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const skip = process.platform === "win32" ? "no process groups on Windows" : false;

function makeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-grace-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.5\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const executor = new ClaudeCodeExecutor({
    binary: config.claude.binary,
    strictMcpConfig: true,
    allowBypassPermissions: false,
    resultGraceMs: 300,
  });
  const runs = new RunManager(config, new RunRepository(db), executor);
  const cleanup = async () => {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { project: realpathSync(project), runs, cleanup };
}

const graceNotes = (app, runId) =>
  app.runs
    .events(runId)
    .filter((e) => e.type === "note" && e.payload?.graceKill)
    .map((e) => e.payload);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a child still running after its result is ended and the run completes", { skip }, async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "linger", projectPath: app.project });
    const t0 = Date.now();
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.ok(Date.now() - t0 < 5_000, "ended by the grace kill, not by the timeout");
    assert.equal(run.resultText, "Done: created hello.txt");
    const notes = graceNotes(app, run.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].graceKill.childAlive, true);
    assert.equal(notes[0].graceKill.afterMs, 300);
    assert.match(notes[0].message, /still running 0\.3 s after the result line/);
  } finally {
    await app.cleanup();
  }
});

test("a descendant holding stdout after the child exits is killed with the group", { skip }, async () => {
  const app = makeApp();
  let hookPid = null;
  try {
    const started = await app.runs.startRun({ prompt: "linger-hook", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.exitCode, 0);
    const notes = graceNotes(app, run.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].graceKill.childAlive, false);
    hookPid = Number(readFileSync(path.join(app.project, "hook.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(hookPid), false, "the hook process was killed");
  } finally {
    if (hookPid && alive(hookPid)) process.kill(hookPid, "SIGKILL");
    await app.cleanup();
  }
});

test("a child that exits after its result gets no grace kill", { skip }, async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    await new Promise((r) => setTimeout(r, 500)); // past the 300 ms grace
    assert.deepEqual(graceNotes(app, run.id), []);
  } finally {
    await app.cleanup();
  }
});
