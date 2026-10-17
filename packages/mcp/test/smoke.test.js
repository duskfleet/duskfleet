/**
 * End-to-end smoke test using the fake Claude binary. Exercises the real
 * RunManager, executor, SQLite storage and state machine without network.
 *
 *   npm run build && npm test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeExecutor,
  loadConfig,
  looksLikeContextExhaustion,
  openDatabase,
  RunManager,
  RunRepository,
  summarizeRun,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

function makeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-test-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  const realProject = realpathSync(project); // validation resolves symlinks (/tmp -> /private/tmp on macOS)
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  writeFileSync(
    path.join(configDir, "agents", "connected.md"),
    `---\npermission_mode: dontAsk\ninherit_mcp: true\nadd_dirs: ["${root}/extra"]\nallowed_tools: ["mcp__claude_ai_Figma", "mcp__plugin_productivity_atlassian", "mcp__claude_ai_Figma__get_metadata"]\n---\nUse MCP.\n`,
  );
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const executor = new ClaudeCodeExecutor({
    binary: config.claude.binary,
    strictMcpConfig: true,
    allowBypassPermissions: false,
  });
  const runs = new RunManager(config, new RunRepository(db), executor);
  const cleanup = async () => {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300)); // let killed processes close and handlers settle
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, config, project: realProject, runs, db, cleanup };
}

test("successful run is recorded with metrics", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project, model: "haiku" });
    assert.equal(started.status, "running");
    assert.ok(started.claudeSessionId);
    assert.equal(started.command.binary, fakeBinary);
    assert.equal(started.command.cwd, app.project);
    assert.deepEqual(started.command.argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
    assert.ok(started.command.argv.includes("--model") && started.command.argv.includes("haiku"));
    assert.ok(started.command.argv.includes("--append-system-prompt"));

    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.modelUsed, "haiku");
    assert.equal(run.exitCode, 0);
    assert.equal(run.numTurns, 2);
    assert.equal(run.toolCalls, 1);
    assert.equal(run.inputTokens, 22);
    assert.equal(run.outputTokens, 13);
    assert.equal(run.cacheReadTokens, 24254);
    assert.equal(run.costUsd, 0.0123);
    assert.equal(run.resultText, "Done: created hello.txt");
    assert.equal(run.terminationReason, "completed");
    assert.equal(run.humanIntervention, false);
    assert.ok(run.durationMs >= 0);

    const events = app.runs.events(run.id).map((e) => e.type);
    assert.deepEqual(events, ["status_change", "status_change", "init", "tool_use", "status_change"]);
  } finally {
    await app.cleanup();
  }
});

test("error result marks the run failed", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "error", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "failed");
    assert.equal(run.exitCode, 1);
    assert.match(run.error, /API Error/);
    assert.equal(run.terminationReason, "api_error");
  } finally {
    await app.cleanup();
  }
});

test("permission denials flag human intervention", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "denied", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.permissionDenials, 1);
    assert.equal(run.humanIntervention, true);
  } finally {
    await app.cleanup();
  }
});

test("crash without result line fails with exit code", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "crash", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "failed");
    assert.equal(run.exitCode, 3);
    assert.match(run.error, /no result message/);
  } finally {
    await app.cleanup();
  }
});

test("timeout kills a hanging run", async () => {
  const app = makeApp(); // default_timeout_minutes: 0.05 = 3s
  try {
    const started = await app.runs.startRun({ prompt: "hang", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "timed_out");
  } finally {
    await app.cleanup();
  }
});

test("cancel_run stops a running process", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "hang", projectPath: app.project });
    await new Promise((r) => setTimeout(r, 300));
    app.runs.cancelRun(started.id);
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "cancelled");
    assert.equal(app.runs.activeCount(), 0);
  } finally {
    await app.cleanup();
  }
});

test("subagent invocations are recorded as run_agents rows with the persona hash", async () => {
  const app = makeApp();
  try {
    mkdirSync(path.join(app.project, ".claude", "agents"), { recursive: true });
    writeFileSync(
      path.join(app.project, ".claude", "agents", "reviewer.md"),
      `---\ndescription: Reviews diffs\ntools: Bash, Read\n---\nReview.\n`,
    );
    const started = await app.runs.startRun({ prompt: "subagent", projectPath: app.project, model: "opus" });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.modelUsed, "opus", "the subagent's haiku must not become the run model");
    assert.equal(run.resultText, "Reviewer found two issues.");
    assert.equal(run.toolCalls, 3, "Agent call + two subagent tool calls");

    const subagents = app.runs.agents(run.id);
    assert.equal(subagents.length, 1);
    const [s] = subagents;
    assert.equal(s.runId, run.id);
    assert.equal(s.subagentType, "reviewer");
    assert.equal(s.description, "Review the diff");
    assert.equal(s.prompt, "Review the diff and report problems. Do not edit files.");
    assert.equal(s.resultText, "[Subagent hand-back] Two findings: x is unused; y lacks a test.");
    assert.equal(s.status, "completed");
    assert.equal(s.model, "claude-haiku-5-5");
    assert.equal(s.parentAgentId, null);
    assert.equal(s.parentToolUseId, "toolu_agent_1");
    assert.equal(s.toolCalls, 2);
    assert.deepEqual(s.tools, ["Bash", "Read"]);
    assert.deepEqual(s.usage, { inputTokens: 5, outputTokens: 60, cacheReadTokens: 500, cacheCreationTokens: 300 });
    assert.equal(s.totalTokens, 865, "from task_notification");
    assert.equal(s.durationMs, 4500);
    assert.equal(s.startedAt, "2026-10-12T20:27:46.000Z", "first nested message's timestamp");
    assert.equal(s.endedAt, "2026-10-12T20:27:50.000Z");
    assert.match(s.definitionHash, /^[0-9a-f]{12}$/, "hash of .claude/agents/reviewer.md");

    const events = app.runs.events(run.id);
    assert.deepEqual(
      events.map((e) => [e.type, e.agentId]),
      [
        ["status_change", null],
        ["status_change", null],
        ["init", null],
        ["tool_use", null],
        ["subagent_start", "a6b73b2ad14bf09f8"],
        ["tool_use", "a6b73b2ad14bf09f8"],
        ["tool_use", "a6b73b2ad14bf09f8"],
        ["subagent_end", "a6b73b2ad14bf09f8"],
        ["status_change", null],
      ],
    );
    assert.equal(events[7].payload.status, "completed");
  } finally {
    await app.cleanup();
  }
});

test("a subagent still open when the run is cancelled is recorded as interrupted", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "subagent-hang", projectPath: app.project });
    // Wait for the subagent row (written on subagent_start), then a short settle for the two
    // nested tool calls the fake binary emits right after it before hanging. The run timeout
    // is 3 s, so the wait is bounded well below it; a fixed 500 ms was flaky on slow runners.
    const deadline = Date.now() + 2_000;
    while (app.runs.agents(started.id).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 200));
    app.runs.cancelRun(started.id);
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "cancelled");
    const [s] = app.runs.agents(run.id);
    assert.equal(s.subagentType, "reviewer");
    assert.equal(s.status, "interrupted");
    assert.equal(s.endedAt, run.endedAt);
    assert.equal(s.toolCalls, 2);
    assert.equal(s.definitionHash, null, "no .claude/agents/reviewer.md in this project");
    assert.equal(app.runs.events(run.id).filter((e) => e.type === "subagent_end").length, 1);
  } finally {
    await app.cleanup();
  }
});

test("project validation rejects paths outside allowed roots", async () => {
  const app = makeApp();
  try {
    await assert.rejects(
      () => app.runs.startRun({ prompt: "ok", projectPath: tmpdir() }),
      /outside allowed_project_roots/,
    );
    await assert.rejects(() => app.runs.startRun({ prompt: "ok", projectPath: "relative/path" }), /must be absolute/);
    await assert.rejects(() => app.runs.startRun({ prompt: "ok" }), /project_path or project_id/);
  } finally {
    await app.cleanup();
  }
});

test("orphaned runs are failed on restart", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "hang", projectPath: app.project });
    // Simulate a restart: new RunManager over the same database.
    const repo = new RunRepository(app.db);
    const fresh = new RunManager(
      app.config,
      repo,
      new ClaudeCodeExecutor({ binary: fakeBinary, strictMcpConfig: true, allowBypassPermissions: false }),
    );
    assert.equal(fresh.recoverOrphans(), 1);
    assert.equal(fresh.getRun(started.id).status, "failed");
  } finally {
    await app.cleanup();
  }
});

test("private data/projects.yaml merges over config/projects.yaml", () => {
  const app = makeApp();
  try {
    const dataDir = app.config.dataDir;
    writeFileSync(
      path.join(app.root, "config", "projects.yaml"),
      `projects:\n  shared:\n    path: ${app.project}\n  mine:\n    path: ${app.project}\n    description: versioned\n`,
    );
    writeFileSync(
      path.join(dataDir, "projects.yaml"),
      `projects:\n  mine:\n    path: ${app.project}\n    description: private\n    inherit_mcp: true\n`,
    );
    const fresh = app.runs.reloadConfig();
    assert.deepEqual([...fresh.projects.keys()].sort(), ["mine", "shared"]);
    assert.equal(fresh.projects.get("mine").description, "private", "private entry wins");
    assert.equal(fresh.projects.get("mine").inheritMcp, true);
    assert.equal(fresh.userProjectsFile, path.join(dataDir, "projects.yaml"));
  } finally {
    app.cleanup();
  }
});

test("inherit_mcp drops --strict-mcp-config and add_dirs become --add-dir", async () => {
  const app = makeApp();
  try {
    const strict = await app.runs.startRun({ prompt: "ok", projectPath: app.project });
    assert.ok(strict.command.argv.includes("--strict-mcp-config"), "default runs are strict");
    assert.ok(!strict.command.argv.includes("--add-dir"));
    await app.runs.waitForRun(strict.id, 10_000); // one run per project at a time

    const open = await app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId: "connected" });
    assert.ok(!open.command.argv.includes("--strict-mcp-config"), "inherit_mcp removes the strict flag");
    const i = open.command.argv.indexOf("--add-dir");
    assert.ok(i >= 0 && open.command.argv[i + 1] === `${app.root}/extra`);
    assert.ok(open.command.argv.includes("mcp__claude_ai_Figma"));
    assert.equal(open.permissionMode, "dontAsk");
    await app.runs.waitForRun(open.id, 10_000);
  } finally {
    await app.cleanup();
  }
});

test("denied tool calls are recorded per tool and flag the run for review", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "denied", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.permissionDenials, 1);
    assert.deepEqual(run.deniedTools, [{ tool: "Bash", summary: null }]);
    assert.equal(run.humanIntervention, true);
    const summary = app.runs.listRuns({ limit: 1 })[0];
    assert.equal(summary.id, run.id);
    assert.deepEqual(summary.deniedTools, [{ tool: "Bash", summary: null }]);
  } finally {
    await app.cleanup();
  }
});

test("a second run on a busy project or a busy agent is refused, not queued", async () => {
  const app = makeApp();
  try {
    const other = path.join(app.root, "project2");
    mkdirSync(other);
    const first = await app.runs.startRun({ prompt: "hang", projectPath: app.project });
    await assert.rejects(
      () => app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId: "connected" }),
      /project busy: run .* \(agent coder\)/,
    );
    await assert.rejects(
      () => app.runs.startRun({ prompt: "ok", projectPath: realpathSync(other) }),
      /agent busy: coder/,
    );
    const okRun = await app.runs.startRun({ prompt: "ok", projectPath: realpathSync(other), agentId: "connected" });
    assert.equal(okRun.status, "running", "different project and different agent is fine");
    app.runs.cancelRun(first.id);
    await app.runs.waitForRun(first.id, 10_000);
    await app.runs.waitForRun(okRun.id, 10_000);
  } finally {
    await app.cleanup();
  }
});

test("MCP servers mounted and allow-list mismatches are recorded on the run", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId: "connected" });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.deepEqual(run.mcp.mounted, [{ name: "claude.ai Figma", status: "connected" }]);
    assert.deepEqual(run.mcp.used, []);
    assert.deepEqual(
      run.mcp.allowListedMissing,
      ["mcp__plugin_productivity_atlassian"],
      "tool-level entries resolve to their server prefix",
    );
    const notes = app.runs
      .events(run.id)
      .filter((e) => e.type === "note")
      .map((e) => e.payload.message);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /never mounted.*mcp__plugin_productivity_atlassian.*mounted: mcp__claude_ai_Figma/);
    const summary = summarizeRun(app.runs.listRuns({ limit: 1 })[0]);
    assert.equal(summary.id, run.id);
    assert.equal(summary.needsReview, true);
    assert.deepEqual(summary.mcpAllowListedMissing, ["mcp__plugin_productivity_atlassian"]);
  } finally {
    await app.cleanup();
  }
});

test("context exhaustion is detected from structured signals, not from prose", () => {
  const base = {
    isError: false,
    subtype: "success",
    terminalReason: "completed",
    stopReason: "end_turn",
    sessionId: null,
    resultText: null,
    numTurns: 1,
    durationMs: 1,
    costUsd: 0,
    usage: {},
    permissionDenials: 0,
    deniedTools: [],
    modelUsed: null,
    raw: null,
  };
  assert.equal(
    looksLikeContextExhaustion({
      ...base,
      resultText: "The page listing may be an open-page limitation CLAUDE.md describes; context is fine.",
    }),
    false,
  );
  assert.equal(looksLikeContextExhaustion({ ...base, terminalReason: "context_window_exceeded" }), true);
  assert.equal(
    looksLikeContextExhaustion({
      ...base,
      isError: true,
      subtype: "error_during_execution",
      resultText: "API Error: prompt is too long",
    }),
    true,
  );
  assert.equal(
    looksLikeContextExhaustion({ ...base, isError: false, resultText: "prompt is too long, said the user, jokingly" }),
    false,
  );
});
