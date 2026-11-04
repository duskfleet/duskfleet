/**
 * run_artifacts end to end (issue #382): a fake-claude run that pushes a branch, reads HEAD and
 * opens a PR ends with one row per artifact; a run without git activity has none.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import { ClaudeCodeExecutor, loadConfig, openDatabase, RunManager, RunRepository } from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

function makeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-artifacts-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.1\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const repo = new RunRepository(db);
  const runs = new RunManager(
    config,
    repo,
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const cleanup = async () => {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 200));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { project: realpathSync(project), runs, repo, db, cleanup };
}

const view = (rows) => rows.map(({ kind, value, source }) => ({ kind, value, source }));

test("a run that pushes and opens a PR records pr, branch and commit", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "git-pr", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.deepEqual(view(app.runs.artifacts(run.id)), [
      { kind: "branch", value: "issue/7-fix-login", source: "tool_result" },
      { kind: "commit", value: "0123456789abcdef0123456789abcdef01234567", source: "tool_result" },
      { kind: "pr", value: "https://github.com/example/demo/pull/8", source: "tool_result" },
    ]);
  } finally {
    await app.cleanup();
  }
});

test("a run without git activity records no artifact", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.deepEqual(app.runs.artifacts(run.id), []);
  } finally {
    await app.cleanup();
  }
});

test("run_artifacts is unique on (run, kind, value) and cascades with its run", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    const pr = { kind: "pr", value: "https://github.com/o/r/pull/1", source: "result_text" };
    app.repo.addArtifacts(run.id, [pr, { ...pr, source: "tool_result" }]);
    app.repo.addArtifacts(run.id, [pr]);
    assert.deepEqual(view(app.repo.listArtifacts(run.id)), [pr], "one row, the first source kept");
    assert.throws(
      () =>
        app.db
          .prepare(
            "INSERT INTO run_artifacts (run_id, kind, value, source, created_at) VALUES (?, 'pr', ?, 'result_text', 'x')",
          )
          .run(run.id, pr.value),
      /UNIQUE/,
    );
    assert.throws(() => app.repo.addArtifacts(run.id, [{ kind: "tag", value: "v1", source: "tool_result" }]), /CHECK/);
    app.db.prepare("DELETE FROM run_events WHERE run_id = ?").run(run.id);
    app.db.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
    assert.deepEqual(app.repo.listArtifacts(run.id), []);
  } finally {
    await app.cleanup();
  }
});
