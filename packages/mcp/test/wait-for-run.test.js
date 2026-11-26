/**
 * RunManager.waitForRun with a wait above the longest setTimeout delay (review of #519): Node clamps
 * a delay above 2^31 - 1 ms to 1 ms, so a gate waiting timeout_minutes * 60000 + 30000 ms at the
 * MAX_TIMEOUT_MINUTES cap used to return at once with the run still running, and cancel it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import {
  ClaudeCodeExecutor,
  loadConfig,
  MAX_TIMEOUT_MINUTES,
  openDatabase,
  RunManager,
  RunRepository,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

test("waitForRun longer than the longest timer still waits for the run to end", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-wait-"));
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
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  try {
    const started = await runs.startRun({ prompt: "hello", projectPath: realpathSync(project) });
    // What the gate waits at the cap: above 2^31 - 1 ms.
    const gateWaitMs = MAX_TIMEOUT_MINUTES * 60_000 + 30_000;
    assert.ok(gateWaitMs > 2 ** 31 - 1);
    const run = await runs.waitForRun(started.id, gateWaitMs);
    assert.equal(run.status, "completed");
  } finally {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 200));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
