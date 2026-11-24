/**
 * Effort overrides (issue #497): `run_agent { effort }` / `run --effort` (StartRunInput.effort), a
 * schedule's `effort` (migration 35), `gate.agent.effort` and `agents create --effort`. The
 * override wins over the agent's `effort:`, reaches the child's argv on the three harnesses (fake
 * CLIs only) and is the value stored on the run; an unknown level is refused, never dropped.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeExecutor,
  CodexExecutor,
  CopilotExecutor,
  effortRefusal,
  HarnessRegistry,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
  ScheduleRepository,
  Scheduler,
  willResume,
} from "@duskfleet/core";
import { testEnv } from "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");
const fakeCopilot = path.join(here, "fake-copilot.js");
const fakeCodex = path.join(here, "fake-codex.js");
const cliEntry = path.join(here, "..", "dist", "cli.js");

const AGENTS = {
  "claude-high": "effort: high",
  "claude-none": "permission_mode: dontAsk",
  "copilot-high": "harness: copilot\nallowed_tools: [write]\neffort: high",
  "codex-high": "harness: codex\npermission_mode: acceptEdits\neffort: high",
};

const PROMPT = { claude: "hello", copilot: "fixture:edit", codex: "fixture:edit" };

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-effort-override-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    [
      "data_dir: ../data",
      `allowed_project_roots: [${JSON.stringify(root)}]`,
      "claude:",
      `  binary: ${JSON.stringify(fakeClaude)}`,
      "  default_max_budget_usd: 2",
      "copilot:",
      `  binary: ${JSON.stringify(fakeCopilot)}`,
      "codex:",
      `  binary: ${JSON.stringify(fakeCodex)}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(configDir, "projects.yaml"),
    `projects:\n  demo:\n    path: ${JSON.stringify(realpathSync(project))}\n`,
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
  const schedules = new ScheduleRepository(db);
  const scheduler = new Scheduler(schedules, runs, { tickMs: 1000, holder: "A" });
  const fireAndWait = async (id) => {
    schedules.update(id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await scheduler.tick();
    await scheduler.settled();
    return runs.waitForRun(schedules.get(id).lastRunId, 15_000);
  };
  const cleanup = () => {
    scheduler.stop();
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { db, configDir, project: realpathSync(project), runs, repo, schedules, scheduler, fireAndWait, cleanup };
}

/** The effort as it appears in each harness's argv. */
function argvEffort(harness, argv) {
  if (harness === "claude") return argv[argv.indexOf("--effort") + 1] ?? null;
  if (harness === "copilot") return argv[argv.indexOf("--reasoning-effort") + 1] ?? null;
  const setting = argv.find((a) => a.startsWith("model_reasoning_effort="));
  return setting ? setting.slice("model_reasoning_effort=".length).replace(/"/g, "") : null;
}

test("an effort override wins over the agent's, reaches the argv and is stored, on every harness", async () => {
  const t = setup();
  try {
    for (const harness of ["claude", "copilot", "codex"]) {
      const agentId = `${harness}-high`;
      const started = await t.runs.startRun({
        agentId,
        projectPath: t.project,
        prompt: PROMPT[harness],
        effort: "low",
      });
      assert.equal(started.effort, "low", `${agentId}: on the started run`);
      const run = await t.runs.waitForRun(started.id, 15_000);
      assert.equal(argvEffort(harness, run.command.argv), "low", `${agentId}: argv ${run.command.argv.join(" ")}`);
      assert.equal(t.repo.get(run.id).effort, "low", `${agentId}: in the row`);

      const plain = await t.runs.waitForRun(
        (await t.runs.startRun({ agentId, projectPath: t.project, prompt: PROMPT[harness] })).id,
        15_000,
      );
      assert.equal(plain.effort, "high", `${agentId}: without an override the agent's effort applies`);
      assert.equal(argvEffort(harness, plain.command.argv), "high");
    }
  } finally {
    t.cleanup();
  }
});

test("an unknown effort level is refused by field name before any row is written", async () => {
  const t = setup();
  try {
    await assert.rejects(
      t.runs.startRun({ agentId: "claude-high", projectPath: t.project, prompt: "hello", effort: "huge" }),
      /effort must be one of low, medium, high, xhigh, max/,
    );
    assert.equal(t.runs.listRuns({}).length, 0);
  } finally {
    t.cleanup();
  }
});

test("effortRefusal names the field on a harness whose capabilities lack effort", () => {
  const noEffort = () => ({ effort: false });
  assert.equal(
    effortRefusal("low", "gate.agent.effort", { id: "x", harness: "other" }, noEffort),
    'agent "x": gate.agent.effort is not supported by harness other',
  );
  assert.equal(effortRefusal(undefined, "effort", { id: "x" }, noEffort), null, "unset is never refused");
  assert.equal(effortRefusal("max", "effort", { id: "x" }), null);
});

test("a schedule's effort round-trips, fires with it, and without it the agent's applies", async () => {
  const t = setup();
  try {
    const s = t.scheduler.create({
      name: "efforted",
      agentId: "claude-high",
      projectId: "demo",
      prompt: "hello",
      cron: "0 3 * * *",
      effort: "medium",
    });
    assert.equal(t.schedules.get(s.id).effort, "medium");
    const fired = await t.fireAndWait(s.id);
    assert.equal(fired.effort, "medium");
    assert.equal(argvEffort("claude", fired.command.argv), "medium");

    t.scheduler.update(s.id, { prompt: "hello" });
    assert.equal(t.schedules.get(s.id).effort, "medium", "an omitted effort is kept");
    t.scheduler.update(s.id, { effort: null });
    assert.equal(t.schedules.get(s.id).effort, null);
    assert.equal((await t.fireAndWait(s.id)).effort, "high", "the agent's effort applies again");

    assert.throws(() => t.scheduler.update(s.id, { effort: "huge" }), /effort must be one of/);
    assert.throws(
      () =>
        t.scheduler.create({
          name: "bad",
          agentId: "claude-none",
          projectId: "demo",
          prompt: "hello",
          cron: "0 3 * * *",
          effort: "huge",
        }),
      /effort must be one of/,
    );
  } finally {
    t.cleanup();
  }
});

test("a gate agent's effort reaches the gate run; an unknown one is refused on create", async () => {
  const t = setup();
  try {
    const s = t.scheduler.create({
      name: "gated",
      agentId: "claude-high",
      projectId: "demo",
      prompt: "hello",
      cron: "0 3 * * *",
      gate: { agent: { agentId: "claude-none", prompt: "hello", effort: "xhigh" } },
    });
    await t.fireAndWait(s.id);
    const gate = t.db.prepare("SELECT id, effort FROM runs WHERE kind = 'gate'").get();
    assert.equal(gate.effort, "xhigh");
    assert.equal(argvEffort("claude", t.repo.get(gate.id).command.argv), "xhigh");

    assert.throws(
      () =>
        t.scheduler.update(s.id, {
          gate: { agent: { agentId: "claude-none", prompt: "hello", effort: "huge" } },
        }),
      /gate\.agent\.effort must be one of/,
    );
  } finally {
    t.cleanup();
  }
});

test("willResume: an edit of the schedule's effort after the failure starts fresh", () => {
  const schedule = { onFailure: "resume_once", agentId: "a", projectId: "p", prompt: "go", model: null };
  const lastRun = {
    status: "timed_out",
    terminationReason: "timeout",
    claudeSessionId: "s",
    resumedFromRunId: null,
    agentId: "a",
    projectId: "p",
    prompt: "go",
    modelRequested: null,
    effort: "high",
  };
  const agent = { onFailure: undefined, project: undefined, effort: "high" };
  assert.equal(willResume({ ...schedule, effort: null }, agent, lastRun, false), true, "same effort as before");
  assert.equal(willResume({ ...schedule, effort: "low" }, agent, lastRun, false), false, "effort edited");
  assert.equal(willResume({ ...schedule, effort: "high" }, { ...agent, effort: undefined }, lastRun, false), true);
});

function cli(configDir, args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    encoding: "utf8",
  });
}

test("CLI: run --effort and agents create --effort; an unknown level is a usage error", () => {
  const t = setup();
  try {
    const run = cli(t.configDir, [
      "run",
      "--project",
      "demo",
      "--agent",
      "claude-high",
      "--effort",
      "low",
      "--json",
      "--",
      "hi",
    ]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).effort, "low");

    const bad = cli(t.configDir, [
      "run",
      "--project",
      "demo",
      "--agent",
      "claude-high",
      "--effort",
      "huge",
      "--",
      "hi",
    ]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--effort must be one of low, medium, high, xhigh, max, got "huge"/);

    const created = cli(t.configDir, ["agents", "create", "thinker", "--effort", "max", "--json", "--", "Be brief."]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).agent.effort, "max");

    const refused = cli(t.configDir, ["agents", "create", "dreamer", "--effort", "huge", "--", "Be brief."]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /effort/);
  } finally {
    t.cleanup();
  }
});
