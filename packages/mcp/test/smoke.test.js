/**
 * End-to-end smoke test using the fake Claude binary. Exercises the real
 * RunManager, executor, SQLite storage and state machine without network.
 *
 *   npm run build && npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "@duskfleet/core";
import { ClaudeCodeExecutor } from "@duskfleet/core";
import { RunManager } from "@duskfleet/core";
import { openDatabase } from "@duskfleet/core";
import { RunRepository } from "@duskfleet/core";
import { budgetPlan, looksLikeContextExhaustion, needsReview, reviewReasons, summarizeRun, WRAP_UP_PROMPT } from "@duskfleet/core";

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
  writeFileSync(path.join(configDir, "agents", "no-reserve.md"), `---\nmax_budget_usd: 2\nwrap_up_reserve_usd: 0\n---\nNo wrap-up.\n`);
  writeFileSync(path.join(configDir, "agents", "tiny.md"), `---\nmax_budget_usd: 0.6\n---\nTiny budget.\n`);
  writeFileSync(
    path.join(configDir, "agents", "connected.md"),
    `---\npermission_mode: dontAsk\ninherit_mcp: true\nadd_dirs: ["${root}/extra"]\nallowed_tools: ["mcp__claude_ai_Figma", "mcp__plugin_productivity_atlassian", "mcp__claude_ai_Figma__get_metadata"]\n---\nUse MCP.\n`,
  );
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const executor = new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false });
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
    writeFileSync(path.join(app.project, ".claude", "agents", "reviewer.md"), `---\ndescription: Reviews diffs\ntools: Bash, Read\n---\nReview.\n`);
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
    assert.equal(s.resultText, "Two findings:\n- x is unused\n- y lacks a test.", "hand-back frame, indent and footer stripped");
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

test("subagent rows recorded by an older parser are repaired from the jsonl log on read", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "subagent", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    // What the 2026-10-14 run looked like to its reader: no type, no brief, raw report, no duration.
    app.db
      .prepare("UPDATE run_agents SET subagent_type = 'unknown', description = NULL, prompt = NULL, result_text = ?, duration_ms = NULL, total_tokens = NULL, tool_calls = 0 WHERE run_id = ?")
      .run("[Subagent hand-back] frame. The report follows:\n  raw report\nagentId: x\n<usage>tool_uses: 2</usage>", run.id);
    const [s] = app.runs.agents(run.id);
    assert.equal(s.subagentType, "reviewer");
    assert.equal(s.description, "Review the diff");
    assert.equal(s.prompt, "Review the diff and report problems. Do not edit files.");
    assert.equal(s.resultText, "Two findings:\n- x is unused\n- y lacks a test.", "the log's report replaces the raw one");
    assert.equal(s.durationMs, 4500);
    assert.equal(s.totalTokens, 865);
    assert.equal(s.toolCalls, 2);
    // Written back: a plain read of the table now has it too.
    const row = app.db.prepare("SELECT subagent_type, prompt, duration_ms FROM run_agents WHERE run_id = ?").get(run.id);
    assert.equal(row.subagent_type, "reviewer");
    assert.equal(row.duration_ms, 4500);
  } finally {
    await app.cleanup();
  }
});

test("a subagent still open when the run is cancelled is recorded as interrupted", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "subagent-hang", projectPath: app.project });
    await new Promise((r) => setTimeout(r, 500));
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
    await assert.rejects(() => app.runs.startRun({ prompt: "ok", projectPath: tmpdir() }), /outside allowed_project_roots/);
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
    const fresh = new RunManager(app.config, repo, new ClaudeCodeExecutor({ binary: fakeBinary, strictMcpConfig: true, allowBypassPermissions: false }));
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
    writeFileSync(path.join(app.root, "config", "projects.yaml"), `projects:\n  shared:\n    path: ${app.project}\n  mine:\n    path: ${app.project}\n    description: versioned\n`);
    writeFileSync(path.join(dataDir, "projects.yaml"), `projects:\n  mine:\n    path: ${app.project}\n    description: private\n    inherit_mcp: true\n`);
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
    await assert.rejects(() => app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId: "connected" }), /project busy: run .* \(agent coder\)/);
    await assert.rejects(() => app.runs.startRun({ prompt: "ok", projectPath: realpathSync(other) }), /agent busy: coder/);
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
    assert.deepEqual(run.mcp.allowListedMissing, ["mcp__plugin_productivity_atlassian"], "tool-level entries resolve to their server prefix");
    const notes = app.runs.events(run.id).filter((e) => e.type === "note").map((e) => e.payload.message);
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

test("the budget is split: main pass gets budget minus reserve, reserve defaults to 10% with a $0.50 floor and a half cap", () => {
  const claude = { defaultMaxBudgetUsd: 5 };
  assert.deepEqual(budgetPlan({}, { claude }), { total: 5, main: 4.5, reserve: 0.5 });
  assert.deepEqual(budgetPlan({ maxBudgetUsd: 20 }, { claude }), { total: 20, main: 18, reserve: 2 });
  assert.deepEqual(budgetPlan({ maxBudgetUsd: 0.6 }, { claude }), { total: 0.6, main: 0.3, reserve: 0.3 }, "the floor never takes more than half");
  assert.deepEqual(budgetPlan({ maxBudgetUsd: 5, wrapUpReserveUsd: 1 }, { claude }), { total: 5, main: 4, reserve: 1 });
  assert.deepEqual(budgetPlan({ maxBudgetUsd: 2, wrapUpReserveUsd: 0 }, { claude }), { total: 2, main: 2, reserve: 0 }, "0 disables the wrap-up");
  assert.deepEqual(budgetPlan({ maxBudgetUsd: 2, wrapUpReserveUsd: 5 }, { claude }), { total: 2, main: 1, reserve: 1 }, "an oversized reserve is capped");
});

test("a budget-exhausted main pass is followed by a wrap-up pass on the same session, recorded on the same run", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "budget", projectPath: app.project, model: "haiku" });
    const i = started.command.argv.indexOf("--max-budget-usd");
    assert.equal(started.command.argv[i + 1], "4.5", "the main pass is launched with budget minus reserve");
    assert.ok(started.command.argv.includes("--session-id"));

    const run = await app.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "failed", "the task was not finished: the run is still a failure");
    assert.equal(run.terminationReason, "budget_exhausted");
    assert.match(run.error, /Reached maximum budget \(\$4\.5\)/, "the errors[] text replaces the useless 'exit code 1'");
    assert.equal(run.resultText, "Stopped after step 2 of 4 (budget); progress recorded in STATUS.md.", "the wrap-up's final message is the run's result");
    assert.equal(run.costUsd, 4.52, "main cost + wrap-up cost");
    assert.equal(run.numTurns, 4);
    assert.equal(run.toolCalls, 2);
    assert.equal(run.inputTokens, 33);
    assert.equal(run.claudeSessionId, started.claudeSessionId, "resumed, not forked");
    assert.equal(app.runs.activeCount(), 0);

    assert.equal(run.phases.length, 2);
    const [main, wrap] = run.phases;
    assert.equal(main.phase, "main");
    assert.equal(main.outcome, "failed");
    assert.equal(main.terminationReason, "budget_exhausted");
    assert.equal(main.budgetUsd, 4.5);
    assert.equal(main.costUsd, 4.5);
    assert.equal(wrap.phase, "wrap_up");
    assert.equal(wrap.outcome, "completed");
    assert.equal(wrap.budgetUsd, 0.5);
    assert.equal(wrap.costUsd, 0.02);
    assert.equal(wrap.numTurns, 1);
    assert.ok(Date.parse(wrap.startedAt) >= Date.parse(main.endedAt));

    const summary = summarizeRun(run);
    assert.deepEqual(summary.wrapUp, { outcome: "completed", costUsd: 0.02, durationMs: wrap.durationMs });
    assert.equal(summary.terminationReason, "budget_exhausted");

    const events = app.runs.events(run.id);
    assert.deepEqual(
      events.map((e) => e.type),
      ["status_change", "status_change", "init", "tool_use", "phase", "init", "tool_use", "phase", "status_change"],
      "wrap-up pass: phase started, its own init and tool calls, phase ended; then the single final status change",
    );
    const phases = events.filter((e) => e.type === "phase").map((e) => e.payload);
    assert.deepEqual(phases[0], { phase: "wrap_up", status: "started", budgetUsd: 0.5, mainCostUsd: 4.5, reason: "budget_exhausted" });
    assert.equal(phases[1].status, "ended");
    assert.equal(phases[1].outcome, "completed");
    assert.equal(phases[1].costUsd, 0.02);

    // The log holds both passes, with a marker where the resumed one begins.
    const log = readFileSync(run.logPath, "utf8").split("\n");
    const marker = log.findIndex((l) => l.startsWith(`#resume ${run.claudeSessionId} `));
    assert.ok(marker > 0, "resume marker written");
    assert.equal(log.filter((l) => l.includes('"type":"result"')).length, 2);
  } finally {
    await app.cleanup();
  }
});

test("the wrap-up pass runs claude --resume with the reserve budget and the fixed wrap-up prompt", async () => {
  const app = makeApp();
  try {
    const seen = [];
    const original = app.runs["executor"].execute.bind(app.runs["executor"]);
    app.runs["executor"].execute = (req, onEvent) => {
      seen.push(req);
      return original(req, onEvent);
    };
    const started = await app.runs.startRun({ prompt: "budget", projectPath: app.project });
    await app.runs.waitForRun(started.id, 15_000);
    assert.equal(seen.length, 2);
    const wrap = seen[1];
    assert.equal(wrap.resumeSessionId, started.claudeSessionId);
    assert.equal(wrap.prompt, WRAP_UP_PROMPT);
    assert.equal(wrap.maxBudgetUsd, 0.5);
    assert.equal(wrap.cwd, app.project);
    assert.equal(wrap.permissionMode, seen[0].permissionMode);
    assert.equal(wrap.appendSystemPrompt, seen[0].appendSystemPrompt, "same envelope as the main pass");
    assert.ok(wrap.timeoutMs <= 10 * 60_000);
    const argv = app.runs["executor"].buildArgv(wrap);
    const r = argv.indexOf("--resume");
    assert.equal(argv[r + 1], started.claudeSessionId);
    assert.ok(!argv.includes("--session-id"), "a resumed pass never passes --session-id");
    assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "0.5");
    assert.equal(argv[argv.length - 1], WRAP_UP_PROMPT);
  } finally {
    await app.cleanup();
  }
});

test("a wrap-up pass that exhausts the reserve too ends the run once; no third pass", async () => {
  const app = makeApp();
  process.env.FAKE_CLAUDE_RESUME = "budget";
  try {
    const started = await app.runs.startRun({ prompt: "budget", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "failed");
    assert.equal(run.phases.length, 2);
    assert.equal(run.phases[1].outcome, "failed");
    assert.equal(run.phases[1].terminationReason, "budget_exhausted");
    assert.equal(run.costUsd, 5, "main 4.5 + reserve 0.5: never more than max_budget_usd");
    assert.equal(run.resultText, "Budget is nearly exhausted; about to record progress.", "no result text in a budget stop: last assistant text");
    assert.equal(app.runs.activeCount(), 0);
  } finally {
    delete process.env.FAKE_CLAUDE_RESUME;
    await app.cleanup();
  }
});

test("wrap_up_reserve_usd: 0 disables the wrap-up pass; the whole budget goes to the main pass", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "budget", projectPath: app.project, agentId: "no-reserve" });
    assert.equal(started.command.argv[started.command.argv.indexOf("--max-budget-usd") + 1], "2");
    const run = await app.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "failed");
    assert.equal(run.terminationReason, "budget_exhausted");
    assert.equal(run.costUsd, 2);
    assert.deepEqual(run.phases.map((p) => p.phase), ["main"]);
    assert.equal(app.runs.events(run.id).filter((e) => e.type === "phase").length, 0, "no phase events for single-pass runs");
  } finally {
    await app.cleanup();
  }
});

test("cancelling during the wrap-up pass records the run as cancelled", async () => {
  const app = makeApp();
  process.env.FAKE_CLAUDE_RESUME = "hang";
  try {
    const started = await app.runs.startRun({ prompt: "budget", projectPath: app.project });
    await new Promise((r) => setTimeout(r, 800)); // main pass done, wrap-up hanging
    assert.equal(app.runs.activeCount(), 1, "the run is still active while the wrap-up pass runs");
    app.runs.cancelRun(started.id);
    const run = await app.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "cancelled");
    assert.deepEqual(run.phases.map((p) => [p.phase, p.outcome]), [["main", "failed"], ["wrap_up", "cancelled"]]);
  } finally {
    delete process.env.FAKE_CLAUDE_RESUME;
    await app.cleanup();
  }
});

test("needs review: every run that ended before the agent chose to stop, from one shared rule", () => {
  const base = { status: "completed", terminationReason: "completed", error: null, exitCode: 0, humanIntervention: false, permissionDenials: 0, contextExhausted: false, mcp: { allowListedMissing: [] } };
  assert.deepEqual(reviewReasons(base), []);
  assert.equal(needsReview(base), false);
  assert.deepEqual(reviewReasons({ ...base, status: "failed", exitCode: 1, terminationReason: "budget_exhausted" }), ["budget_exhausted", "nonzero_exit"]);
  assert.deepEqual(reviewReasons({ ...base, status: "failed", exitCode: null, terminationReason: "error_max_budget_usd" }), ["budget_exhausted"], "the subtype alone is enough");
  assert.deepEqual(reviewReasons({ ...base, status: "timed_out", terminationReason: null, exitCode: null }), ["timed_out"]);
  assert.deepEqual(reviewReasons({ ...base, status: "failed", terminationReason: null, exitCode: null, error: "orphaned: DuskFleet restarted while this run was in progress" }), ["orphaned"]);
  assert.deepEqual(reviewReasons({ ...base, status: "failed", terminationReason: null, exitCode: 3, error: "no result message received (exit 3)" }), ["nonzero_exit"]);
  assert.deepEqual(reviewReasons({ ...base, status: "failed", terminationReason: null, exitCode: null, error: "spawn failed: ENOENT" }), ["failed"], "a failure with no finer reason is still a reason");
  assert.deepEqual(reviewReasons({ ...base, status: "completed", exitCode: 2 }), ["nonzero_exit"], "a completed run with a non-zero exit code is suspicious");
  assert.deepEqual(reviewReasons({ ...base, permissionDenials: 2, humanIntervention: true }), ["permission_denied"]);
  assert.deepEqual(reviewReasons({ ...base, contextExhausted: true }), ["context_exhausted"]);
  assert.deepEqual(reviewReasons({ ...base, mcp: { allowListedMissing: ["mcp__x"] } }), ["mcp_missing"]);
  assert.deepEqual(reviewReasons({ ...base, status: "cancelled", terminationReason: null, exitCode: null }), [], "a person cancelled it: nothing to review");
  assert.deepEqual(reviewReasons({ ...base, status: "running", terminationReason: null, exitCode: null }), []);
  assert.deepEqual(reviewReasons({ ...base, status: "failed", exitCode: 1, terminationReason: "api_error", error: "API Error" }), ["nonzero_exit"]);
});

test("needs review is true for budget, timeout, crash and orphan runs, and false for a cancelled one", async () => {
  const app = makeApp();
  try {
    const budget = await app.runs.waitForRun((await app.runs.startRun({ prompt: "budget", projectPath: app.project, agentId: "no-reserve" })).id, 15_000);
    assert.equal(summarizeRun(budget).needsReview, true);
    assert.deepEqual(summarizeRun(budget).reviewReasons, ["budget_exhausted", "nonzero_exit"]);

    const crash = await app.runs.waitForRun((await app.runs.startRun({ prompt: "crash", projectPath: app.project })).id, 15_000);
    assert.equal(summarizeRun(crash).needsReview, true);
    assert.deepEqual(summarizeRun(crash).reviewReasons, ["nonzero_exit"]);

    const hung = await app.runs.startRun({ prompt: "hang", projectPath: app.project });
    const timedOut = await app.runs.waitForRun(hung.id, 15_000);
    assert.equal(timedOut.status, "timed_out");
    assert.deepEqual(summarizeRun(timedOut).reviewReasons, ["timed_out"]);

    const cancelledRun = await app.runs.startRun({ prompt: "hang", projectPath: app.project });
    await new Promise((r) => setTimeout(r, 200));
    app.runs.cancelRun(cancelledRun.id);
    const cancelled = await app.runs.waitForRun(cancelledRun.id, 15_000);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(summarizeRun(cancelled).needsReview, false);

    const orphanRun = await app.runs.startRun({ prompt: "hang", projectPath: app.project });
    const fresh = new RunManager(app.config, new RunRepository(app.db), new ClaudeCodeExecutor({ binary: fakeBinary, strictMcpConfig: true, allowBypassPermissions: false }));
    fresh.recoverOrphans();
    const orphan = fresh.getRun(orphanRun.id);
    assert.deepEqual(summarizeRun(orphan).reviewReasons, ["orphaned"]);
    app.runs.cancelRun(orphanRun.id);
    await app.runs.waitForRun(orphanRun.id, 15_000);
  } finally {
    await app.cleanup();
  }
});

test("context exhaustion is detected from structured signals, not from prose", () => {
  const base = { isError: false, subtype: "success", terminalReason: "completed", stopReason: "end_turn", sessionId: null, resultText: null, numTurns: 1, durationMs: 1, costUsd: 0, usage: {}, permissionDenials: 0, deniedTools: [], modelUsed: null, raw: null };
  assert.equal(looksLikeContextExhaustion({ ...base, resultText: "The page listing may be an open-page limitation CLAUDE.md describes; context is fine." }), false);
  assert.equal(looksLikeContextExhaustion({ ...base, terminalReason: "context_window_exceeded" }), true);
  assert.equal(looksLikeContextExhaustion({ ...base, isError: true, subtype: "error_during_execution", resultText: "API Error: prompt is too long" }), true);
  assert.equal(looksLikeContextExhaustion({ ...base, isError: false, resultText: "prompt is too long, said the user, jokingly" }), false);
});
