/**
 * Runs record the effort they were started with (issue #496, migration 34): the agent's `effort:`
 * as put on the execution request, NULL when the agent sets none. Checked on the three harnesses
 * (fake CLIs only), in the row, in summarizeRun (list_runs) and in the run-info renderer.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.js";
import {
  ClaudeCodeExecutor,
  CodexExecutor,
  CopilotExecutor,
  HarnessRegistry,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
  summarizeRun,
} from "@duskfleet/core";
import { renderRunInfo } from "../dist/render/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");
const fakeCopilot = path.join(here, "fake-copilot.js");
const fakeCodex = path.join(here, "fake-codex.js");

const AGENTS = {
  "claude-high": "effort: high",
  "claude-none": "permission_mode: dontAsk",
  "copilot-high": "harness: copilot\nallowed_tools: [write]\neffort: high",
  "copilot-none": "harness: copilot\nallowed_tools: [write]",
  "codex-high": "harness: codex\npermission_mode: acceptEdits\neffort: high",
  "codex-none": "harness: codex\npermission_mode: acceptEdits",
};

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-effort-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    [
      "data_dir: ../data",
      `allowed_project_roots: ["${root}"]`,
      "claude:",
      `  binary: "${fakeClaude}"`,
      "  default_max_budget_usd: 2",
      "copilot:",
      `  binary: "${fakeCopilot}"`,
      "codex:",
      `  binary: "${fakeCodex}"`,
      "",
    ].join("\n"),
  );
  for (const [id, frontmatter] of Object.entries(AGENTS)) {
    writeFileSync(path.join(configDir, "agents", `${id}.md`), `---\n${frontmatter}\n---\nBe brief.\n`);
  }
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const registry = new HarnessRegistry([
    new ClaudeCodeExecutor({ binary: fakeClaude, strictMcpConfig: true, allowBypassPermissions: false }),
    new CopilotExecutor({ binary: config.copilot.binary }),
    new CodexExecutor({ binary: config.codex.binary }),
  ]);
  const repo = new RunRepository(db);
  const runs = new RunManager(config, repo, registry);
  const cleanup = () => {
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { db, project: realpathSync(project), runs, repo, cleanup };
}

const PROMPT = { claude: "hello", copilot: "fixture:edit", codex: "fixture:edit" };

test("a run records the requested effort, NULL without one, on every harness", async () => {
  const t = setup();
  try {
    for (const harness of ["claude", "copilot", "codex"]) {
      for (const [suffix, want] of [
        ["high", "high"],
        ["none", null],
      ]) {
        const agentId = `${harness}-${suffix}`;
        const started = await t.runs.startRun({ agentId, projectPath: t.project, prompt: PROMPT[harness] });
        assert.equal(started.harness, harness);
        assert.equal(started.effort, want, `${agentId}: on the started run`);
        const run = await t.runs.waitForRun(started.id, 15_000);
        assert.equal(run.effort, want, `${agentId}: on the ended run`);
        const row = t.db.prepare("SELECT effort FROM runs WHERE id = ?").get(run.id);
        assert.equal(row.effort, want, `${agentId}: in the row`);
        assert.equal(t.repo.get(run.id).effort, want, `${agentId}: read back`);
        assert.equal(summarizeRun(run).effort, want, `${agentId}: in list_runs`);
      }
    }
  } finally {
    t.cleanup();
  }
});

test("an older row (effort NULL) reads as no effort", () => {
  const t = setup();
  try {
    t.db
      .prepare(
        `INSERT INTO runs (id, agent_id, project_path, prompt, status, created_at, permission_mode, command_json)
         VALUES ('old', 'claude-high', ?, 'p', 'completed', '2026-01-01T00:00:00Z', 'dontAsk', '{"binary":"c","argv":[],"cwd":"/"}')`,
      )
      .run(t.project);
    assert.equal(t.repo.get("old").effort, null);
  } finally {
    t.cleanup();
  }
});

test("run-info shows an effort line only when one was requested", async () => {
  const t = setup();
  try {
    const high = await t.runs.waitForRun(
      (await t.runs.startRun({ agentId: "claude-high", projectPath: t.project, prompt: "hello" })).id,
      15_000,
    );
    const none = await t.runs.waitForRun(
      (await t.runs.startRun({ agentId: "claude-none", projectPath: t.project, prompt: "hello" })).id,
      15_000,
    );
    const opts = { color: false, width: 100, now: new Date("2026-11-24T12:00:00Z") };
    const lines = (run) => renderRunInfo({ run, label: "x", costLabel: "Cost", diff: null, subagents: [] }, opts);
    assert.ok(lines(high).includes("  effort        high"));
    assert.ok(!lines(none).some((l) => l.startsWith("  effort")));
  } finally {
    t.cleanup();
  }
});
