/**
 * Run titles (#386): run_agent { title } / run --title / a schedule's title stamped on every fire,
 * normalizeRunTitle (trimmed, empty = none, max RUN_TITLE_MAX) and runLabel, the one label every
 * reader shows (title, else the first prompt line).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeExecutor,
  loadConfig,
  normalizeRunTitle,
  openDatabase,
  RUN_TITLE_MAX,
  RunManager,
  RunRepository,
  runLabel,
  ScheduleRepository,
  Scheduler,
  summarizeRun,
} from "@duskfleet/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testEnv } from "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-title-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: true\n  tick_seconds: 5\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.5\n`,
  );
  writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  demo:\n    path: ${project}\n`);
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\nproject: demo\n---\nBe brief.\n`);
  return { root, configDir, project };
}

function makeApp() {
  const { root, configDir } = makeRoot();
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const scheduler = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const fireAndWait = async (id) => {
    repo.update(id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await scheduler.tick();
    await scheduler.settled();
    return runs.waitForRun(repo.get(id).lastRunId, 15_000);
  };
  const cleanup = async () => {
    scheduler.stop();
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { runs, repo, scheduler, fireAndWait, cleanup };
}

test("normalizeRunTitle trims, maps empty to null and refuses more than RUN_TITLE_MAX characters", () => {
  assert.equal(normalizeRunTitle(undefined), null);
  assert.equal(normalizeRunTitle(null), null);
  assert.equal(normalizeRunTitle("   "), null);
  assert.equal(normalizeRunTitle("  fix #381 "), "fix #381");
  assert.equal(normalizeRunTitle(`  ${"x".repeat(RUN_TITLE_MAX)}  `), "x".repeat(RUN_TITLE_MAX));
  assert.throws(() => normalizeRunTitle("x".repeat(RUN_TITLE_MAX + 1)), /at most 120 characters/);
});

test("runLabel is the title when set, else the first prompt line, cleaned and cut", () => {
  assert.equal(runLabel({ title: "nightly review", prompt: "## Do the thing\nmore" }), "nightly review");
  assert.equal(runLabel({ title: null, prompt: "\n\n## **Do** the thing\nmore" }), "Do the thing");
  assert.equal(runLabel({ title: null, prompt: "  \n " }), "(empty prompt)");
  const long = runLabel({ title: null, prompt: `${"word ".repeat(40)}end` });
  assert.ok(long.endsWith("…") && long.length <= 81, long);
});

test("a run started with a title keeps it; without one nothing changes", async () => {
  const app = makeApp();
  try {
    const titled = await app.runs.startRun({ prompt: "ok", agentId: "coder", title: "  fix #381  " });
    const done = await app.runs.waitForRun(titled.id, 15_000);
    assert.equal(done.status, "completed");
    assert.equal(done.title, "fix #381");
    assert.equal(summarizeRun(done).title, "fix #381");
    assert.equal(summarizeRun(done).label, "fix #381");

    const plain = await app.runs.waitForRun((await app.runs.startRun({ prompt: "ok", agentId: "coder" })).id, 15_000);
    assert.equal(plain.title, null);
    assert.equal(summarizeRun(plain).label, "ok");

    const empty = await app.runs.waitForRun(
      (await app.runs.startRun({ prompt: "ok", agentId: "coder", title: "  " })).id,
      15_000,
    );
    assert.equal(empty.title, null, "empty = none");

    await assert.rejects(
      app.runs.startRun({ prompt: "ok", agentId: "coder", title: "x".repeat(RUN_TITLE_MAX + 1) }),
      /title must be at most/,
    );
    assert.equal(app.runs.listRuns({}).length, 3, "a refused title records no run");
  } finally {
    await app.cleanup();
  }
});

test("a schedule's title is stamped on every run it fires; update changes or clears it", async () => {
  const app = makeApp();
  try {
    const s = app.scheduler.create({
      name: "titled",
      agentId: "coder",
      prompt: "ok",
      cron: "* * * * *",
      title: " nightly review ",
    });
    assert.equal(app.repo.get(s.id).title, "nightly review");
    const first = await app.fireAndWait(s.id);
    assert.equal(first.title, "nightly review");
    const second = await app.fireAndWait(s.id);
    assert.equal(second.title, "nightly review");

    app.scheduler.update(s.id, { title: "renamed" });
    assert.equal((await app.fireAndWait(s.id)).title, "renamed");
    app.scheduler.update(s.id, { prompt: "ok" });
    assert.equal(app.repo.get(s.id).title, "renamed", "an omitted title is kept");
    app.scheduler.update(s.id, { title: "" });
    assert.equal(app.repo.get(s.id).title, null);
    assert.equal((await app.fireAndWait(s.id)).title, null);

    assert.throws(() => app.scheduler.update(s.id, { title: "x".repeat(RUN_TITLE_MAX + 1) }), /title must be at most/);
    assert.throws(
      () =>
        app.scheduler.create({
          name: "too long",
          agentId: "coder",
          prompt: "ok",
          cron: "* * * * *",
          title: "x".repeat(RUN_TITLE_MAX + 1),
        }),
      /title must be at most/,
    );
  } finally {
    await app.cleanup();
  }
});

function parse(result) {
  assert.equal(result.isError ?? false, false, `tool returned error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test("MCP: run_agent title shows in get_run and list_runs; create_schedule takes a title", async () => {
  const { root, configDir } = makeRoot();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await client.connect(transport);
    const run = parse(
      await client.callTool({ name: "run_agent", arguments: { prompt: "ok", title: "fix #381", wait_seconds: 10 } }),
    );
    assert.equal(run.status, "completed");
    assert.equal(run.title, "fix #381");
    assert.equal(run.label, "fix #381");

    const got = parse(await client.callTool({ name: "get_run", arguments: { run_id: run.id } }));
    assert.equal(got.title, "fix #381");
    assert.equal(got.label, "fix #381");

    const plain = parse(await client.callTool({ name: "run_agent", arguments: { prompt: "ok", wait_seconds: 10 } }));
    assert.equal(plain.title, null);
    assert.equal(plain.label, "ok");

    const listed = parse(await client.callTool({ name: "list_runs", arguments: {} }));
    assert.deepEqual(
      listed.runs.map((r) => [r.title, r.label]),
      [
        [null, "ok"],
        ["fix #381", "fix #381"],
      ],
    );

    const tooLong = await client.callTool({
      name: "run_agent",
      arguments: { prompt: "ok", title: "x".repeat(RUN_TITLE_MAX + 1) },
    });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0].text, /title must be at most/);

    const created = parse(
      await client.callTool({
        name: "create_schedule",
        arguments: { name: "titled", agent_id: "coder", prompt: "ok", cron: "0 3 * * *", title: "nightly review" },
      }),
    );
    assert.equal(created.schedule.title, "nightly review");
    const updated = parse(
      await client.callTool({ name: "update_schedule", arguments: { id: created.schedule.id, title: "" } }),
    );
    assert.equal(updated.schedule.title, null);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
