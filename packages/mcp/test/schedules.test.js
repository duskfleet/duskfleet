/**
 * Scheduler: CRUD over MCP, a due schedule fires through RunManager on tick,
 * busy agents are skipped (not queued), the kill switch stops firing, and two
 * processes cannot both hold the lease.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  autoPauseReason,
  BusyError,
  ClaudeCodeExecutor,
  DailyCapError,
  DEFAULT_NOOP_PATTERN,
  isNoopRun,
  loadConfig,
  NOOP_TEXT_LIMIT,
  openDatabase,
  parseNoopPattern,
  RunManager,
  RunRepository,
  ScheduleRepository,
  Scheduler,
  scheduleProjectId,
} from "@duskfleet/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testEnv } from "./helpers.js"; // drops an inherited CLAUDE_BIN before any executor is built

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-sched-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: true\n  tick_seconds: 5\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  demo:\n    path: ${project}\n`);
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\nproject: demo\n---\nBe brief.\n`);
  writeFileSync(path.join(configDir, "agents", "free.md"), `---\n---\nUnbound.\n`);
  writeFileSync(
    path.join(configDir, "agents", "resumer.md"),
    `---\nproject: demo\nmax_budget_usd: 2\nwrap_up_reserve_usd: 0\non_failure: resume_once\nresume_budget_usd: 3\n---\nRetry once.\n`,
  );
  writeFileSync(
    path.join(configDir, "agents", "gatekeeper.md"),
    `---\nproject: demo\nmodel: haiku\n---\nCheck for work.\n`,
  );
  return { root, configDir, project: realpathSync(project) };
}

function makeScheduler(configDir) {
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const scheduler = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const due = (id) => repo.update(id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  /** A tick plus the gated fires it started in the background. */
  const tickAll = async () => {
    await scheduler.tick();
    await scheduler.settled();
  };
  const fireAndWait = async (id) => {
    due(id);
    await tickAll();
    const s = repo.get(id);
    return runs.waitForRun(s.lastRunId, 15_000);
  };
  const close = async (root) => {
    scheduler.stop();
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { config, db, runs, repo, scheduler, due, tickAll, fireAndWait, close };
}

function ok(result) {
  assert.equal(result.isError ?? false, false, `tool returned error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}
function fails(result, pattern) {
  assert.equal(result.isError, true, "expected the tool to fail");
  assert.match(result.content[0].text, pattern);
}

test("schedules over MCP: create, list, update, run now, delete; validation errors", async () => {
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
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["list_schedules", "create_schedule", "update_schedule", "delete_schedule", "run_schedule_now"])
      assert.ok(tools.includes(t), t);

    const created = ok(
      await client.callTool({
        name: "create_schedule",
        arguments: { name: "coder hourly", agent_id: "coder", prompt: "ok", cron: "0 8-20 * * 1-5" },
      }),
    );
    assert.equal(created.schedule.timeZone, "Europe/London");
    assert.equal(created.schedule.cronHuman, "weekdays 08–20 at :00");
    assert.equal(created.schedule.projectId, null, "bound agent: project comes from the agent");
    assert.equal(created.schedule.effectiveProjectId, "demo", "effective project = the agent's");
    assert.ok(created.schedule.nextRunAt, "next_run_at computed");
    assert.equal(created.schedule.enabled, true);

    fails(
      await client.callTool({
        name: "create_schedule",
        arguments: { name: "coder hourly", agent_id: "coder", prompt: "ok", cron: "0 * * * *" },
      }),
      /already exists/,
    );
    fails(
      await client.callTool({
        name: "create_schedule",
        arguments: { name: "bad cron", agent_id: "coder", prompt: "ok", cron: "0 8" },
      }),
      /5 fields/,
    );
    fails(
      await client.callTool({
        name: "create_schedule",
        arguments: { name: "bad tz", agent_id: "coder", prompt: "ok", cron: "0 * * * *", time_zone: "Mars/Olympus" },
      }),
      /unknown time zone/,
    );
    fails(
      await client.callTool({
        name: "create_schedule",
        arguments: { name: "no project", agent_id: "free", prompt: "ok", cron: "0 * * * *" },
      }),
      /not bound to a project; pass project_id/,
    );
    fails(
      await client.callTool({
        name: "create_schedule",
        arguments: { name: "no agent", agent_id: "ghost", prompt: "ok", cron: "0 * * * *" },
      }),
      /unknown agent/,
    );

    const listed = ok(await client.callTool({ name: "list_schedules", arguments: {} }));
    assert.equal(listed.schedules.length, 1);
    assert.equal(listed.schedules[0].projectId, null, "list_schedules keeps the stored project_id");
    assert.equal(listed.schedules[0].effectiveProjectId, "demo", "and adds the effective one");
    assert.equal(listed.scheduler.enabled, true);
    assert.equal(listed.scheduler.running, true, "the MCP server ticks");

    const paused = ok(
      await client.callTool({ name: "update_schedule", arguments: { id: created.schedule.id, enabled: false } }),
    );
    assert.equal(paused.schedule.enabled, false);
    assert.equal(paused.schedule.nextRunAt, null, "paused schedules have no next run");
    const resumed = ok(
      await client.callTool({
        name: "update_schedule",
        arguments: { id: created.schedule.id, enabled: true, cron: "30 9 * * 1-5", model: "haiku" },
      }),
    );
    assert.equal(resumed.schedule.cronHuman, "weekdays at 09:30");
    assert.equal(resumed.schedule.model, "haiku");

    const fired = ok(await client.callTool({ name: "run_schedule_now", arguments: { id: created.schedule.id } }));
    assert.equal(fired.outcome, "started");
    assert.ok(fired.runId);
    assert.equal(fired.schedule.fires, 1);
    assert.equal(fired.schedule.lastRunId, fired.runId);
    const run = ok(await client.callTool({ name: "get_run", arguments: { run_id: fired.runId } }));
    assert.equal(run.scheduleId, created.schedule.id, "runs remember the schedule that started them");
    assert.equal(run.projectId, "demo");
    assert.ok(run.command.argv.includes("haiku"), "schedule model override reaches the command");

    // run again immediately: the agent is still busy → skipped, not queued
    const skipped = ok(await client.callTool({ name: "run_schedule_now", arguments: { id: created.schedule.id } }));
    assert.equal(skipped.outcome, "skipped_busy");
    assert.match(skipped.error, /agent busy|project busy/);
    assert.equal(skipped.schedule.skips, 1);

    // The row says how the last run ended, not only that it started: a budget-exhausted
    // run is "needs review" right on the schedule (on 2026-10-14 one stayed green for 11 hours).
    ok(await client.callTool({ name: "update_schedule", arguments: { id: created.schedule.id, prompt: "budget" } }));
    for (let i = 0; i < 50; i++) {
      const r = ok(await client.callTool({ name: "get_run", arguments: { run_id: fired.runId } }));
      if (r.status !== "running") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const budgetFire = ok(await client.callTool({ name: "run_schedule_now", arguments: { id: created.schedule.id } }));
    assert.equal(budgetFire.outcome, "started");
    assert.equal(budgetFire.schedule.lastRun.id, budgetFire.runId);
    assert.equal(budgetFire.schedule.lastRun.status, "running");
    assert.equal(budgetFire.schedule.lastRun.needsReview, false, "nothing to review while it runs");
    let after;
    for (let i = 0; i < 100; i++) {
      after = ok(await client.callTool({ name: "list_schedules", arguments: {} })).schedules[0];
      if (after.lastRun.status !== "running") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(after.lastOutcome, "started", "the tick outcome alone looks fine");
    assert.equal(after.lastRun.status, "failed");
    assert.equal(after.lastRun.needsReview, true);
    assert.deepEqual(after.lastRun.reviewReasons, ["budget_exhausted", "nonzero_exit"]);
    assert.equal(after.lastRun.terminationReason, "budget_exhausted");
    assert.equal(after.lastRun.costUsd, 4.52, "main pass plus wrap-up pass");
    const listed2 = ok(await client.callTool({ name: "list_runs", arguments: { limit: 1 } }));
    assert.equal(listed2.runs[0].needsReview, true);

    // on_failure: resume_once on the schedule: the next fire resumes that run, and both runs link to each other
    const withPolicy = ok(
      await client.callTool({
        name: "update_schedule",
        arguments: { id: created.schedule.id, on_failure: "resume_once", resume_budget_usd: 2 },
      }),
    );
    assert.equal(withPolicy.schedule.onFailure, "resume_once");
    assert.equal(withPolicy.schedule.effectiveOnFailure, "resume_once");
    assert.equal(
      withPolicy.schedule.willResumeRunId,
      budgetFire.runId,
      "list_schedules says what the next tick will do",
    );
    const resumedFire = ok(await client.callTool({ name: "run_schedule_now", arguments: { id: created.schedule.id } }));
    assert.equal(resumedFire.outcome, "resumed");
    let retry;
    for (let i = 0; i < 100; i++) {
      retry = ok(await client.callTool({ name: "get_run", arguments: { run_id: resumedFire.runId } }));
      if (retry.status !== "running") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(retry.resumedFromRunId, budgetFire.runId);
    assert.equal(retry.status, "completed");
    const original = ok(await client.callTool({ name: "get_run", arguments: { run_id: budgetFire.runId } }));
    assert.equal(original.resumedByRunId, retry.id, "get_run links the original to its retry");
    const both = ok(await client.callTool({ name: "list_runs", arguments: { limit: 2 } })).runs;
    assert.equal(both[0].id, retry.id);
    assert.equal(both[0].resumedFromRunId, budgetFire.runId);
    assert.equal(both[1].resumedByRunId, retry.id, "list_runs links both ways");
    const cleared = ok(
      await client.callTool({
        name: "update_schedule",
        arguments: { id: created.schedule.id, clear_on_failure: true },
      }),
    );
    assert.equal(cleared.schedule.onFailure, null);
    assert.equal(cleared.schedule.effectiveOnFailure, "none", "back to the agent's policy");
    assert.equal(cleared.schedule.willResumeRunId, null);
    fails(
      await client.callTool({
        name: "update_schedule",
        arguments: { id: created.schedule.id, noop_pattern: "idle", clear_noop_pattern: true },
      }),
      /cannot be used together/,
    );

    const deleted = ok(await client.callTool({ name: "delete_schedule", arguments: { id: created.schedule.id } }));
    assert.equal(deleted.deleted, true);
    fails(await client.callTool({ name: "delete_schedule", arguments: { id: created.schedule.id } }), /not found/);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduleProjectId: the schedule's project, else its agent's, else null", () => {
  assert.equal(scheduleProjectId({ projectId: "demo" }, { project: undefined }), "demo", "schedule project");
  assert.equal(scheduleProjectId({ projectId: "demo" }, { project: "demo" }), "demo", "both set, same project");
  assert.equal(scheduleProjectId({ projectId: null }, { project: "app" }), "app", "bound agent");
  assert.equal(scheduleProjectId({ projectId: null }, { project: undefined }), null, "unbound agent");
  assert.equal(scheduleProjectId({ projectId: null }, undefined), null, "deleted agent");
  assert.equal(scheduleProjectId({ projectId: "demo" }, undefined), "demo", "deleted agent, schedule project");
});

test("tick fires due schedules, honours the kill switch, and only the lease holder fires", async () => {
  const { root, configDir, project } = makeRoot();
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const a = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const b = new Scheduler(repo, runs, { tickMs: 1000, holder: "B" });
  try {
    const s = a.create({ name: "every minute", agentId: "coder", prompt: "ok", cron: "* * * * *" });
    // make it due now
    repo.update(s.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    await a.tick();
    assert.equal(a.status().leaseHeldByThisProcess, true);
    let after = repo.get(s.id);
    assert.equal(after.lastOutcome, "started");
    assert.ok(after.lastRunId);
    assert.ok(new Date(after.nextRunAt).getTime() > Date.now(), "advanced to the next minute");
    assert.equal(runs.getRun(after.lastRunId).projectPath, project);

    // B cannot take the lease while A holds it
    repo.update(s.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await b.tick();
    assert.equal(b.status().leaseHeldByThisProcess, false);
    assert.equal(repo.get(s.id).fires, 1, "B did not fire");

    // A ticks again while the previous run is still going: busy → skipped
    await a.tick();
    after = repo.get(s.id);
    assert.equal(after.lastOutcome, "skipped_busy");
    assert.equal(after.skips, 1);
    assert.equal(repo.firings(s.id).length, 2);
    assert.deepEqual(repo.firingTotals(new Date(0).toISOString()), { started: 1, skippedBusy: 1 });
    assert.deepEqual(repo.firingTotals(new Date(Date.now() + 60_000).toISOString()), { started: 0, skippedBusy: 0 });

    // kill switch
    writeFileSync(
      path.join(configDir, "duskfleet.yaml"),
      `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: false\nclaude:\n  binary: "${fakeBinary}"\n`,
    );
    await runs.waitForRun(after.lastRunId, 10_000);
    repo.update(s.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await a.tick();
    assert.equal(repo.get(s.id).fires, 1, "nothing fires with the kill switch on");
    assert.equal(a.status().enabled, false);
    assert.equal(a.status().leaseHeldByThisProcess, false, "lease released");

    // with A gone, B takes over
    writeFileSync(
      path.join(configDir, "duskfleet.yaml"),
      `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: true\nclaude:\n  binary: "${fakeBinary}"\n`,
    );
    await b.tick();
    assert.equal(b.status().leaseHeldByThisProcess, true);
    assert.equal(repo.get(s.id).fires, 2);
  } finally {
    a.stop();
    b.stop();
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compare-and-set claim: two tickers on one DB never fire the same tick twice, even across a lease handover", async () => {
  const { root, configDir } = makeRoot();
  const config = loadConfig(configDir);
  // Two processes: own connection, own RunManager, own repository, same database file.
  const side = () => {
    const db = openDatabase(config.dataDir);
    const runs = new RunManager(
      config,
      new RunRepository(db),
      new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
    );
    return { db, runs, repo: new ScheduleRepository(db) };
  };
  const pa = side();
  const pb = side();
  const a = new Scheduler(pa.repo, pa.runs, { tickMs: 1000, holder: "A" });
  const b = new Scheduler(pb.repo, pb.runs, { tickMs: 1000, holder: "B" });
  try {
    const s = a.create({ name: "cas", agentId: "free", projectId: "demo", prompt: "ok", cron: "* * * * *" });
    const dueAt = new Date(Date.now() - 1000).toISOString();
    pa.repo.update(s.id, { nextRunAt: dueAt });

    // The claim itself: only the caller holding the value it read wins.
    const next = new Date(Date.now() + 60_000).toISOString();
    assert.equal(pa.repo.claimDue(s.id, "1999-01-01T00:00:00.000Z", next), false, "stale expectation loses");
    assert.equal(pa.repo.get(s.id).nextRunAt, dueAt, "a lost claim changes nothing");

    // A read the due list, then lost the lease before firing; B took over and fired the tick.
    const stale = pa.repo.due(new Date().toISOString());
    assert.equal(stale.length, 1);
    await b.tick();
    assert.equal(b.status().leaseHeldByThisProcess, true);
    const fired = pb.repo.get(s.id);
    assert.equal(fired.fires, 1);
    assert.ok(Date.parse(fired.nextRunAt) > Date.now(), "B advanced next_run_at");

    // Let B's run end first: both "processes" share this pid, so A's orphan sweep would
    // otherwise take B's live run for its own lost one.
    await pb.runs.waitForRun(fired.lastRunId, 10_000);

    // A gets the lease back and works through its stale snapshot: the CAS fails, nothing fires.
    b.stop(); // releases the lease
    pa.repo.due = () => stale;
    await a.tick();
    assert.equal(a.status().leaseHeldByThisProcess, true);
    const after = pa.repo.get(s.id);
    assert.equal(after.fires, 1, "A did not fire the tick B already fired");
    assert.equal(after.lastRunId, fired.lastRunId);
    assert.equal(pa.repo.firings(s.id).length, 1, "no firing recorded for the lost claim, not even a skip");
    assert.equal(after.nextRunAt, fired.nextRunAt, "next_run_at untouched by the loser");
  } finally {
    a.stop();
    b.stop();
    pa.runs.shutdown();
    pb.runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    pa.db.close();
    pb.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a schedule of a max_concurrent: 2 agent fires while one run is active and skips while two are", async () => {
  const { root, configDir } = makeRoot();
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nmax_concurrent_runs: 10\nscheduler:\n  enabled: true\n  tick_seconds: 5\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(
    path.join(configDir, "agents", "pair.md"),
    `---\nproject: demo\nmax_concurrent: 2\nisolated: true\n---\nWorks in its own worktree.\n`,
  );
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const a = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const fired = [];
  try {
    const s = a.create({ name: "pair every minute", agentId: "pair", prompt: "hang", cron: "* * * * *" });
    const due = () => repo.update(s.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    due();
    await a.tick();
    let after = repo.get(s.id);
    assert.equal(after.lastOutcome, "started");
    fired.push(after.lastRunId);

    // one run of the agent is still active: the limit is 2, so the next tick fires too
    due();
    await a.tick();
    after = repo.get(s.id);
    assert.equal(after.lastOutcome, "started", "fires while one run is active");
    assert.notEqual(after.lastRunId, fired[0]);
    fired.push(after.lastRunId);
    assert.equal(runs.activeCount(), 2);

    // two active: busy → skipped, not queued
    due();
    await a.tick();
    after = repo.get(s.id);
    assert.equal(after.lastOutcome, "skipped_busy");
    assert.equal(after.skips, 1);
    assert.equal(after.fires, 2);
    const skip = repo.firings(s.id).find((f) => f.outcome === "skipped_busy");
    assert.ok(skip, "the skipped firing is recorded");
    assert.match(skip.error, /agent busy: agent pair already has 2 of 2 runs/);
  } finally {
    a.stop();
    for (const id of fired) runs.cancelRun(id);
    for (const id of fired) await runs.waitForRun(id, 10_000);
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("max_daily_runs: the run past the cap is refused with DailyCapError and the tick records skipped_daily_cap", async () => {
  const { root, configDir } = makeRoot();
  writeFileSync(
    path.join(configDir, "agents", "capped.md"),
    `---\nproject: demo\nmax_daily_runs: 2\n---\nTwice a day.\n`,
  );
  const t = makeScheduler(configDir);
  try {
    // Yesterday's run does not count against today's cap (UTC day).
    const old = await t.runs.startRun({ prompt: "ok", agentId: "capped" });
    await t.runs.waitForRun(old.id, 15_000);
    t.db
      .prepare("UPDATE runs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 86_400_000).toISOString(), old.id);
    // A UTC midnight between the two lines would move "today"; the test does not cross one in practice.

    const s = t.scheduler.create({ name: "capped every minute", agentId: "capped", prompt: "ok", cron: "* * * * *" });
    assert.equal((await t.fireAndWait(s.id)).status, "completed");
    assert.equal((await t.fireAndWait(s.id)).status, "completed");

    t.due(s.id);
    await t.tickAll();
    const after = t.repo.get(s.id);
    assert.equal(after.lastOutcome, "skipped_daily_cap");
    assert.equal(after.fires, 2);
    assert.equal(after.skips, 1);
    assert.match(after.lastError, /daily cap: agent capped already started 2 runs today \(UTC\); max_daily_runs is 2/);
    assert.ok(after.nextRunAt > new Date().toISOString(), "a capped tick still advances next_run_at");

    await assert.rejects(t.runs.startRun({ prompt: "ok", agentId: "capped" }), (err) => {
      assert.ok(err instanceof DailyCapError, "refused as DailyCapError");
      assert.ok(!(err instanceof BusyError), "a cap is not busy");
      return true;
    });
    // Other agents are not affected.
    const other = await t.runs.startRun({ prompt: "ok", agentId: "coder" });
    await t.runs.waitForRun(other.id, 15_000);
  } finally {
    await t.close(root);
  }
});

test("max_daily_cost_usd: refused once today's recorded cost reaches the cap; a gated schedule skips before its gate", async () => {
  const { root, configDir, project } = makeRoot();
  // fake-claude reports $0.0123 per run: two runs are $0.0246 >= $0.02
  writeFileSync(
    path.join(configDir, "agents", "thrifty.md"),
    `---\nproject: demo\nmax_daily_cost_usd: 0.02\n---\nCheap.\n`,
  );
  const t = makeScheduler(configDir);
  try {
    for (let i = 0; i < 2; i++) {
      const r = await t.runs.startRun({ prompt: "ok", agentId: "thrifty" });
      assert.equal((await t.runs.waitForRun(r.id, 15_000)).status, "completed");
    }
    assert.match(
      t.runs.dailyCapReason("thrifty"),
      /already spent \$0\.0246 today \(UTC\); max_daily_cost_usd is 0\.02/,
    );
    await assert.rejects(t.runs.startRun({ prompt: "ok", agentId: "thrifty" }), DailyCapError);

    const marker = path.join(project, "gate-ran");
    const s = t.scheduler.create({
      name: "thrifty gated",
      agentId: "thrifty",
      prompt: "ok",
      cron: "* * * * *",
      gate: { command: `touch "${marker}"` },
    });
    t.due(s.id);
    await t.tickAll();
    const after = t.repo.get(s.id);
    assert.equal(after.lastOutcome, "skipped_daily_cap");
    assert.equal(existsSync(marker), false, "the gate did not run for a capped agent");
    const firing = t.repo.firings(s.id)[0];
    assert.equal(firing.outcome, "skipped_daily_cap");
    assert.equal(firing.gateCostUsd, null, "no gate ran on this tick");
  } finally {
    await t.close(root);
  }
});

test("a run request (dashboard 'Run now') is fired by the lease holder on its next tick, even when paused, and cleared", async () => {
  const { root, configDir } = makeRoot();
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const a = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const b = new Scheduler(repo, runs, { tickMs: 1000, holder: "B" });
  try {
    const s = a.create({ name: "paused one", agentId: "coder", prompt: "ok", cron: "0 3 * * *", enabled: false });
    assert.equal(s.runRequestedAt, null);

    // the request is a timestamp on the row, idempotent
    const requested = repo.requestRun(s.id);
    assert.ok(requested.runRequestedAt);
    assert.equal(
      repo.requestRun(s.id).runRequestedAt,
      requested.runRequestedAt,
      "second request keeps the first timestamp",
    );
    assert.equal(repo.requestRun("nope"), null);

    // a non-holder does not consume it
    await a.tick(); // A takes the lease first...
    assert.equal(a.status().leaseHeldByThisProcess, true);
    let after = repo.get(s.id);
    assert.equal(after.lastOutcome, "started", "fired although paused");
    assert.equal(after.runRequestedAt, null, "request cleared");
    assert.equal(after.enabled, false, "still paused");
    assert.equal(after.nextRunAt, null, "a paused schedule gets no next tick");
    assert.equal(runs.getRun(after.lastRunId).scheduleId, s.id);

    // while that run is busy, a new request is a skip, and B (no lease) leaves it alone
    repo.requestRun(s.id);
    await b.tick();
    assert.ok(repo.get(s.id).runRequestedAt, "B did not consume the request");
    await a.tick();
    after = repo.get(s.id);
    assert.equal(after.lastOutcome, "skipped_busy");
    assert.equal(after.runRequestedAt, null);
    assert.equal(repo.firings(s.id).length, 2);
    await runs.waitForRun(after.lastRunId, 10_000);
  } finally {
    a.stop();
    b.stop();
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("`serve` takes the lease from a live mcp / role-less holder; the displaced holder stands by; mcp never preempts", async () => {
  const { root, configDir } = makeRoot();
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const stale = new Scheduler(repo, runs, { tickMs: 1000, holder: "host:523" }); // pre-role build, still ticking
  const mcp = new Scheduler(repo, runs, { tickMs: 1000, role: "mcp" });
  const serve = new Scheduler(repo, runs, { tickMs: 1000, role: "serve" });
  const serve2 = new Scheduler(repo, runs, { tickMs: 1000, holder: "serve@other:2" });
  try {
    await stale.tick();
    assert.equal(stale.status().leaseHeldByThisProcess, true);

    // serve does not wait for the stale holder's lease to expire
    await serve.tick();
    assert.equal(serve.status().leaseHeldByThisProcess, true);
    assert.equal(repo.leaseInfo().holder, serve.status().holder);

    // the displaced holder's renewal fails and it stops ticking
    await stale.tick();
    assert.equal(stale.status().leaseHeldByThisProcess, false);
    await mcp.tick();
    assert.equal(mcp.status().leaseHeldByThisProcess, false, "mcp never preempts a live serve");

    // one serve does not steal from another live serve
    await serve2.tick();
    assert.equal(serve2.status().leaseHeldByThisProcess, false);
    assert.equal(repo.leaseInfo().holder, serve.status().holder);

    // serve gone: mcp takes over once the lease expires, as before
    serve.stop();
    assert.equal(serve.status().leaseHeldByThisProcess, false, "stop releases the lease");
    await mcp.tick();
    assert.equal(mcp.status().leaseHeldByThisProcess, true);
  } finally {
    stale.stop();
    mcp.stop();
    serve.stop();
    serve2.stop();
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("`duskfleet serve` stays alive past its first tick and holds the lease until SIGTERM", async () => {
  const { spawn } = await import("node:child_process");
  const { root, configDir } = makeRoot();
  const cliEntry = path.join(here, "..", "dist", "cli.js");
  const child = spawn(process.execPath, [cliEntry, "serve"], {
    env: testEnv({ DUSKFLEET_CONFIG: configDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let exited = null;
  child.on("exit", (code) => (exited = code));
  try {
    // long enough for bootstrap + the first tick to finish (it used to exit with 0 right after it)
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(exited, null, `serve exited early with ${exited}: ${stderr}`);
    assert.match(stderr, /scheduler ticking every/);
    const db = openDatabase(loadConfig(configDir).dataDir);
    const lease = new ScheduleRepository(db).leaseInfo();
    db.close();
    assert.ok(lease && /^serve@/.test(lease.holder), `lease held by serve, got ${JSON.stringify(lease)}`);
    assert.ok(new Date(lease.expiresAt).getTime() > Date.now(), "lease is live");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    rmSync(root, { recursive: true, force: true });
  }
});

test("on_failure: resume_once resumes a budget-exhausted run on the next tick, once; a second failure is final", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    const s = t.scheduler.create({ name: "resume me", agentId: "resumer", prompt: "budget", cron: "* * * * *" });
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(s.id)), null, "nothing to resume before the first run");

    const first = await t.fireAndWait(s.id);
    assert.equal(first.status, "failed");
    assert.equal(first.terminationReason, "budget_exhausted");
    assert.equal(first.resumedFromRunId, null);
    assert.equal(t.repo.get(s.id).lastOutcome, "started");
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(s.id)).id, first.id, "the next fire will resume it");

    const second = await t.fireAndWait(s.id);
    assert.notEqual(second.id, first.id);
    assert.equal(second.resumedFromRunId, first.id, "linked to the run it resumed");
    assert.equal(second.retries, 1);
    assert.equal(second.claudeSessionId, first.claudeSessionId, "same session");
    assert.equal(second.scheduleId, s.id);
    assert.equal(second.agentId, "resumer");
    const argv = second.command.argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], first.claudeSessionId);
    assert.ok(!argv.includes("--session-id"));
    assert.equal(
      argv[argv.indexOf("--max-budget-usd") + 1],
      "3",
      "resume_budget_usd, with the agent's wrap-up reserve of 0",
    );
    assert.match(second.prompt, /^Your previous session ended early \(budget exhausted\)/);
    assert.equal(second.status, "completed", "the fake's --resume branch finishes the job");
    assert.equal(t.runs.resumedBy(first.id).id, second.id);
    const sched = t.repo.get(s.id);
    assert.equal(sched.lastOutcome, "resumed");
    assert.equal(sched.fires, 2, "a resume is a fire");
    assert.deepEqual(
      t.repo.firings(s.id).map((f) => f.outcome),
      ["resumed", "started"],
    );
    const notes = t.runs
      .events(first.id)
      .filter((e) => e.type === "note")
      .map((e) => e.payload.message);
    assert.ok(
      notes.some((m) => m === `resumed by run ${second.id}`),
      "the original run's timeline links to the retry",
    );
    assert.ok(t.runs.events(second.id).some((e) => e.type === "note" && e.payload.resumedFromRunId === first.id));

    // the resumed run completed: the next tick starts fresh
    const third = await t.fireAndWait(s.id);
    assert.equal(third.resumedFromRunId, null);
    assert.ok(third.command.argv.includes("--session-id"));
    assert.equal(third.prompt, "budget", "the schedule's own prompt again");

    // ...and when the resume fails too, that is final: the tick after starts fresh, no third attempt on that session
    process.env.FAKE_CLAUDE_RESUME = "budget";
    const fourth = await t.fireAndWait(s.id);
    assert.equal(fourth.resumedFromRunId, third.id);
    assert.equal(fourth.status, "failed");
    assert.equal(fourth.terminationReason, "budget_exhausted");
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(s.id)), null, "a failed resume is not resumed again");
    const fifth = await t.fireAndWait(s.id);
    assert.equal(fifth.resumedFromRunId, null, "fresh start after the final failure");
    assert.equal(t.runs.resumedBy(fourth.id), null);
    await assert.rejects(() => t.runs.resumeRun({ runId: third.id }), /already resumed once/);
    await assert.rejects(() => t.runs.resumeRun({ runId: second.id }), /cannot be resumed: it is completed/);
    await assert.rejects(
      () => t.runs.resumeRun({ runId: fourth.id }),
      /is itself a resume of run/,
      "resumeRun enforces once for every caller",
    );
    // the retry row is the claim: a second insert resuming the same run fails in the database
    await assert.rejects(
      () =>
        t.runs.startRun({
          prompt: "again",
          agentId: "resumer",
          projectId: "demo",
          resume: { fromRun: third, budgetUsd: 1 },
        }),
      /already resumed once by run/,
    );
    assert.equal(t.runs.resumedBy(third.id).id, fourth.id);
  } finally {
    delete process.env.FAKE_CLAUDE_RESUME;
    await t.close(root);
  }
});

test("a schedule edit after the failure cancels the resume; a resume refused for a non-busy reason starts fresh", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    const s = t.scheduler.create({ name: "edited", agentId: "resumer", prompt: "budget", cron: "* * * * *" });
    const first = await t.fireAndWait(s.id);
    assert.equal(first.terminationReason, "budget_exhausted");
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(s.id)).id, first.id);
    const listed = t.scheduler.listWithLastRun().find((x) => x.id === s.id);
    assert.equal(listed.willResumeRunId, first.id);
    assert.equal(listed.effectiveOnFailure, "resume_once");
    assert.equal(listed.onFailureSource, "agent");
    assert.equal(listed.lastRun.status, "failed");

    t.scheduler.update(s.id, { prompt: "budget, but differently" });
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(s.id)), null, "a new prompt means a fresh start");
    t.scheduler.update(s.id, { prompt: "budget" });
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(s.id)).id, first.id);
    t.scheduler.update(s.id, { model: "haiku" });
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(s.id)), null, "a new model means a fresh start");
    t.scheduler.update(s.id, { model: null });

    // the resume is refused (e.g. the old run's agent is gone): this fire starts fresh, last_run_id moves on
    const original = t.runs.resumeRun.bind(t.runs);
    t.runs.resumeRun = async () => {
      throw new Error('unknown agent "gone"');
    };
    const fresh = await t.fireAndWait(s.id);
    t.runs.resumeRun = original;
    assert.notEqual(fresh.id, first.id);
    assert.equal(fresh.resumedFromRunId, null);
    assert.equal(t.repo.get(s.id).lastOutcome, "started");
    assert.equal(t.repo.get(s.id).lastRunId, fresh.id);
    assert.ok(
      t.runs
        .events(fresh.id)
        .some(
          (e) => e.type === "note" && /resume of run .* was refused \(unknown agent "gone"\)/.test(e.payload.message),
        ),
    );
  } finally {
    await t.close(root);
  }
});

test("no-op marker: anchored default, trimmed, bounded, bad config pattern falls back", () => {
  const re = parseNoopPattern(DEFAULT_NOOP_PATTERN);
  const done = (text) => isNoopRun({ status: "completed", resultText: text }, re);
  assert.equal(done("Nothing to do: no tickets in Ready."), true);
  assert.equal(done("  No open PRs in ready state."), true);
  assert.equal(
    done("Fixed the build. There is nothing to do for the docs."),
    false,
    "a busy run mentioning it later is not idle",
  );
  assert.equal(done("Fixed it.\nNo flaky tests in ready state after the fix"), false);
  assert.equal(isNoopRun({ status: "failed", resultText: "Nothing to do" }, re), false);
  // trimmed once: the plain path ignores surrounding spaces too; blank is refused
  assert.equal(parseNoopPattern("  nothing here  ").test("Nothing here today"), true);
  assert.throws(() => parseNoopPattern("   "), /invalid noop_pattern/);
  // only the head of the message is tested
  assert.equal(isNoopRun({ status: "completed", resultText: `${"x".repeat(NOOP_TEXT_LIMIT)}idle` }, /idle/), false);

  const { root, configDir } = makeRoot();
  try {
    writeFileSync(
      path.join(configDir, "duskfleet.yaml"),
      `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  noop_pattern: "/(unclosed/i"\nclaude:\n  binary: "${fakeBinary}"\n`,
    );
    assert.equal(
      loadConfig(configDir).scheduler.noopPattern,
      DEFAULT_NOOP_PATTERN,
      "an invalid scheduler.noop_pattern does not break the config",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pause: N ended runs in a row that were empty or needs review pause the schedule with a reason; resume starts a new streak", async () => {
  const { root, configDir } = makeRoot();
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  auto_pause_after: 3\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  const t = makeScheduler(configDir);
  try {
    assert.equal(t.config.scheduler.autoPauseAfter, 3);
    const s = t.scheduler.create({ name: "stuck", agentId: "coder", prompt: "denied", cron: "* * * * *" });
    const first = await t.fireAndWait(s.id);
    assert.deepEqual(first.reviewReasons, ["permission_denied"]);
    // An empty run: completed, no tool calls, nothing to review.
    t.db.prepare("UPDATE runs SET tool_calls = 0, review_reasons_json = '[]' WHERE id = ?").run(first.id);
    await t.fireAndWait(s.id);
    // Two ended runs: below the threshold, the third fire starts a run.
    await t.fireAndWait(s.id);
    assert.equal(t.repo.get(s.id).enabled, true);
    assert.equal(t.runs.listRuns({}).length, 3);

    t.due(s.id);
    await t.tickAll();
    const paused = t.repo.get(s.id);
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
    assert.equal(paused.lastOutcome, "auto_paused");
    assert.match(paused.pausedReason, /last 3 runs .*1 completed with 0 tool calls, 2 needed review/);
    assert.equal(paused.lastError, paused.pausedReason);
    assert.ok(paused.autoPausedAt);
    assert.equal(t.runs.listRuns({}).length, 3, "no fourth run");
    assert.equal(t.scheduler.firings(s.id, 1)[0].outcome, "auto_paused");

    // Resume: reason cleared, the runs before the pause no longer count, so it fires again.
    const resumed = t.scheduler.update(s.id, { enabled: true });
    assert.equal(resumed.pausedReason, null);
    assert.equal(resumed.autoPausedAt, paused.autoPausedAt);
    await t.fireAndWait(s.id);
    assert.equal(t.repo.get(s.id).lastOutcome, "started");
    assert.equal(t.runs.listRuns({}).length, 4);

    // A clean run breaks the streak; 0 disables the check.
    const stub = (rows) => ({ recentEndedRuns: (_id, _since, limit) => rows.slice(0, limit) });
    const bad = { id: "x", empty: false, needsReview: true };
    const clean = { id: "y", empty: false, needsReview: false };
    const sched = { id: "s", autoPausedAt: null };
    assert.equal(autoPauseReason(stub([bad, clean, bad]), sched, 3), null);
    assert.equal(autoPauseReason(stub([bad, bad]), sched, 3), null, "fewer ended runs than the threshold");
    assert.equal(autoPauseReason(stub([bad, bad, bad]), sched, 0), null);
    assert.match(autoPauseReason(stub([bad, bad, bad]), sched, 3), /3 needed review/);
  } finally {
    await t.close(root);
  }
});

test("idle cost: 7-day ticks, fires, no-op runs by marker and what they cost, per schedule", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    const s = t.scheduler.create({ name: "idle", agentId: "coder", prompt: "noop", cron: "* * * * *" });
    await t.fireAndWait(s.id);
    await t.fireAndWait(s.id);
    t.scheduler.update(s.id, { prompt: "ok" });
    await t.fireAndWait(s.id);
    t.scheduler.update(s.id, { prompt: "error" });
    await t.fireAndWait(s.id);
    // a skipped tick counts as a tick, not a fire
    t.scheduler.update(s.id, { prompt: "hang" });
    t.due(s.id);
    await t.scheduler.tick();
    t.due(s.id);
    await t.scheduler.tick();

    const [row] = t.scheduler.listWithLastRun();
    const idle = row.idle7d;
    assert.equal(idle.days, 7);
    assert.equal(idle.ticks, 6);
    assert.equal(idle.fires, 5);
    assert.equal(idle.runs, 5);
    assert.equal(
      idle.noopRuns,
      2,
      "'Nothing to do: no tickets in Ready.' matches the default marker; 'Done' and the failed run do not",
    );
    assert.equal(idle.noopCostUsd, 0.0246);
    assert.equal(idle.noopPattern, DEFAULT_NOOP_PATTERN);
    assert.equal(idle.noopPatternError, null);
    assert.equal(row.willResumeRunId, null, "list rows carry willResumeRunId");
    assert.equal(row.effectiveOnFailure, "none");
    assert.ok(idle.costUsd >= 0.0369);

    // A schedule-specific marker replaces the default; an invalid one is refused.
    t.scheduler.update(s.id, { noopPattern: "created hello" });
    assert.equal(t.scheduler.idleStats(t.repo.get(s.id)).noopRuns, 1);
    assert.throws(() => t.scheduler.update(s.id, { noopPattern: "/(unclosed/" }), /invalid noop_pattern/);
    // A completed run that needs review is blocked, not idle, even when it says "Nothing to do".
    t.scheduler.update(s.id, { noopPattern: null });
    const noop = t.runs.listRuns({ status: "completed" }).find((r) => r.resultText?.startsWith("Nothing to do"));
    t.db.prepare("UPDATE runs SET review_reasons_json = ? WHERE id = ?").run('["permission_denial"]', noop.id);
    assert.equal(t.scheduler.idleStats(t.repo.get(s.id)).noopRuns, 1, "the run that needs review is not a no-op");
    // A stored pattern that no longer parses degrades that row only, never the whole list.
    t.db.prepare("UPDATE schedules SET noop_pattern = ? WHERE id = ?").run("/(unclosed/", s.id);
    const [broken] = t.scheduler.listWithLastRun();
    assert.equal(broken.idle7d.noopRuns, 0);
    assert.equal(broken.idle7d.noopCostUsd, 0);
    assert.equal(broken.idle7d.runs, 5);
    assert.match(broken.idle7d.noopPatternError, /invalid noop_pattern/);
    // Outside the window nothing counts.
    assert.equal(t.scheduler.idleStats(t.repo.get(s.id), 0).runs, 0);
    const hung = t.runs.listRuns({ status: "running" })[0];
    if (hung) t.runs.cancelRun(hung.id);
  } finally {
    await t.close(root);
  }
});

test("command gate: exit 0 runs, non-zero skips with stdout as the reason, a timeout is an error; gates cost nothing", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    const s = t.scheduler.create({
      name: "gated",
      agentId: "coder",
      prompt: "ok",
      cron: "* * * * *",
      gate: { command: "echo 'no Ready tickets'; exit 1" },
    });
    t.due(s.id);
    await t.tickAll();
    let row = t.repo.get(s.id);
    assert.equal(row.lastOutcome, "skipped_gate");
    assert.equal(row.lastError, "no Ready tickets", "stdout kept as the reason");
    assert.equal(row.lastRunId, null, "no run started");
    assert.equal(row.fires, 0);
    assert.equal(row.skips, 1);
    const [f] = t.repo.firings(s.id);
    assert.equal(f.gateCostUsd, 0);
    assert.equal(f.gateRunId, null);

    // the command runs in the project directory
    t.scheduler.update(s.id, { gate: { command: 'test "$(basename "$PWD")" = project' } });
    const run = await t.fireAndWait(s.id);
    assert.equal(run.status, "completed");
    assert.equal(t.repo.get(s.id).lastOutcome, "started");

    // A pipeline that hangs: the timeout kills the whole process group, not only sh, and does
    // not wait for the grandchildren to close the pipes.
    t.scheduler.update(s.id, { gate: { command: "sleep 30 | cat", timeoutSeconds: 1 } });
    t.due(s.id);
    const t0 = Date.now();
    await t.tickAll();
    assert.ok(Date.now() - t0 < 5_000, "the gate ended at its timeout");
    row = t.repo.get(s.id);
    assert.equal(row.lastOutcome, "error");
    assert.match(row.lastError, /gate: gate command timed out after 1s/);

    // skip_gate bypasses it
    t.scheduler.update(s.id, { gate: { command: "exit 1" } });
    const forced = await t.scheduler.fireNow(s.id, { skipGate: true });
    assert.equal(forced.outcome, "started");
    await t.runs.waitForRun(forced.runId, 10_000);

    const idle = t.scheduler.idleStats(t.repo.get(s.id));
    assert.equal(idle.gateChecks, 3, "three ticks asked the gate; the forced fire did not");
    assert.equal(idle.gateSkips, 1);
    assert.equal(idle.gateCostUsd, 0);

    // A broken gate is an error, never "no work": command not found, not executable, killed by a
    // signal. A gate whose stderr says "project busy" is still an error: busy is structured.
    for (const [command, pattern] of [
      ["echo 'project busy' >&2; no-such-gate-tool", /exited 127 \(command not found/],
      ["exit 126", /exited 126 \(not executable\)/],
      ["kill -9 $$", /killed by SIGKILL/],
    ]) {
      t.scheduler.update(s.id, { gate: { command } });
      t.due(s.id);
      await t.tickAll();
      row = t.repo.get(s.id);
      assert.equal(row.lastOutcome, "error", command);
      assert.match(row.lastError, pattern, command);
    }

    // validation
    assert.throws(() => t.scheduler.update(s.id, { gate: {} }), /exactly one of command or agent/);
    assert.throws(
      () => t.scheduler.update(s.id, { gate: { command: "true", agent: { agentId: "gatekeeper", prompt: "x" } } }),
      /exactly one/,
    );
    assert.throws(
      () => t.scheduler.update(s.id, { gate: { agent: { agentId: "ghost", prompt: "x" } } }),
      /gate agent "ghost" is unknown/,
    );
    t.scheduler.update(s.id, { gate: null });
    assert.equal(t.repo.get(s.id).gate, null);
  } finally {
    await t.close(root);
  }
});

test("a stored gate that cannot be read makes every fire an error, never an ungated run", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    const s = t.scheduler.create({
      name: "corrupt",
      agentId: "coder",
      prompt: "ok",
      cron: "* * * * *",
      gate: { command: "true" },
    });
    for (const [json, pattern] of [
      ["{not json", /gate_json is not valid JSON/],
      ['{"timeoutSeconds": 5}', /neither command nor agent/],
    ]) {
      t.db.prepare("UPDATE schedules SET gate_json = ? WHERE id = ?").run(json, s.id);
      assert.ok(t.repo.get(s.id).gate.invalid, "read as an invalid gate, not as no gate");
      t.due(s.id);
      await t.tickAll();
      const row = t.repo.get(s.id);
      assert.equal(row.lastOutcome, "error");
      assert.match(row.lastError, /stored gate is unusable/);
      assert.match(row.lastError, pattern);
      assert.equal(row.lastRunId, null, "the full run did not start");
    }
    assert.equal(t.runs.listRuns({}).length, 0);
  } finally {
    await t.close(root);
  }
});

test("a gated fire claims its tick and runs in the background: the tick goes on, nothing fires twice", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    const s = t.scheduler.create({
      name: "slow gate",
      agentId: "coder",
      prompt: "noop",
      cron: "* * * * *",
      gate: { command: "sleep 2; exit 1", timeoutSeconds: 10 },
    });
    const other = t.scheduler.create({
      name: "plain",
      agentId: "free",
      projectId: "demo",
      prompt: "ok",
      cron: "* * * * *",
    });
    // The gated one first: the plain run then takes the project while the gate is running.
    t.repo.update(s.id, { nextRunAt: new Date(Date.now() - 2000).toISOString() });
    t.repo.update(other.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const t0 = Date.now();
    await t.scheduler.tick();
    assert.ok(Date.now() - t0 < 1_500, "the tick did not wait for the gate");
    assert.equal(t.repo.get(other.id).lastOutcome, "started", "another due schedule fired meanwhile");
    const claimed = t.repo.get(s.id);
    assert.ok(Date.parse(claimed.nextRunAt) > Date.now(), "next_run_at moved on before the gate ended");
    assert.equal(claimed.lastOutcome, null, "the gate is still running");
    // A tick (or another process that took the lease) does not see it as due any more.
    assert.equal(
      t.repo.due(new Date().toISOString()).some((d) => d.id === s.id),
      false,
    );
    // A forced second fire while the gate runs is a busy skip, not a second gate.
    const again = await t.scheduler.fireNow(s.id);
    assert.equal(again.outcome, "skipped_busy");
    assert.match(again.error, /gate from an earlier fire is still running/);
    await t.scheduler.settled();
    const row = t.repo.get(s.id);
    assert.equal(row.lastOutcome, "skipped_gate");
    assert.equal(t.repo.firings(s.id).filter((f) => f.outcome === "skipped_gate").length, 1);
    await t.runs.waitForRun(t.repo.get(other.id).lastRunId, 10_000);
  } finally {
    await t.close(root);
  }
});

test("agent gate: a cheap run decides; NO_WORK skips, its cost is counted apart from run cost; busy skips before the gate", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    const gate = { agent: { agentId: "gatekeeper", prompt: "gate-nowork", budgetUsd: 0.2 } };
    const s = t.scheduler.create({ name: "agent gated", agentId: "coder", prompt: "ok", cron: "* * * * *", gate });
    t.due(s.id);
    await t.tickAll();
    let row = t.repo.get(s.id);
    assert.equal(row.lastOutcome, "skipped_gate", "marker alone on the last line, any case, markdown stripped");
    assert.equal(row.lastError, "Checked the board: nothing in Ready.\n\n**no_work**");
    const [skip] = t.repo.firings(s.id);
    assert.ok(skip.gateRunId);
    assert.equal(skip.gateCostUsd, 0.0123);
    const gateRun = t.runs.getRun(skip.gateRunId);
    assert.equal(gateRun.kind, "gate");
    assert.equal(gateRun.agentId, "gatekeeper");
    assert.equal(gateRun.scheduleId, s.id);
    assert.equal(
      gateRun.command.argv[gateRun.command.argv.indexOf("--max-budget-usd") + 1],
      "0.2",
      "gate budget, no wrap-up reserve",
    );
    assert.ok(gateRun.command.argv.includes("haiku"));

    // a marker that is not the last line lets the real run start
    t.scheduler.update(s.id, { gate: { agent: { agentId: "gatekeeper", prompt: "gate-work" } } });
    const real = await t.fireAndWait(s.id);
    assert.equal(real.kind, "run");
    assert.equal(real.agentId, "coder");
    row = t.repo.get(s.id);
    assert.equal(row.lastOutcome, "started");
    assert.equal(row.lastRunId, real.id, "lastRunId is the real run, never the gate run");
    assert.equal(t.repo.firings(s.id)[0].gateCostUsd, 0.0123);

    const idle = t.scheduler.idleStats(row);
    assert.equal(idle.runs, 1, "gate runs are not counted as runs");
    assert.equal(idle.costUsd, 0.0123);
    assert.equal(idle.gateChecks, 2);
    assert.equal(idle.gateCostUsd, 0.0246);
    assert.equal(t.runs.listRuns({ kind: "gate" }).length, 2);
    assert.equal(t.runs.listRuns({ kind: "run" }).length, 1);

    // the marker mentioned mid-sentence is not a verdict: the real run starts
    t.scheduler.update(s.id, { gate: { agent: { agentId: "gatekeeper", prompt: "gate-mention" } } });
    const mentioned = await t.fireAndWait(s.id);
    assert.equal(mentioned.kind, "run");
    assert.equal(t.repo.get(s.id).lastOutcome, "started");

    // busy: the real agent is still running, so the tick skips without paying for a gate
    t.scheduler.update(s.id, { prompt: "hang" });
    const hung = await t.scheduler.fireNow(s.id, { skipGate: true });
    assert.equal(hung.outcome, "started");
    t.due(s.id);
    await t.tickAll();
    row = t.repo.get(s.id);
    assert.equal(row.lastOutcome, "skipped_busy");
    assert.equal(t.repo.firings(s.id)[0].gateRunId, null, "no gate run while busy");
    assert.equal(t.runs.listRuns({ kind: "gate" }).length, 3);
    t.runs.cancelRun(hung.runId);
    await t.runs.waitForRun(hung.runId, 10_000);
  } finally {
    await t.close(root);
  }
});

test("a timed-out run is resumed too; a schedule's on_failure overrides the agent's in both directions", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    // agent says resume_once, schedule says none → fresh
    const off = t.scheduler.create({
      name: "no retry",
      agentId: "resumer",
      prompt: "budget",
      cron: "* * * * *",
      onFailure: "none",
    });
    const offFirst = await t.fireAndWait(off.id);
    assert.equal(offFirst.status, "failed");
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(off.id)), null);
    const offSecond = await t.fireAndWait(off.id);
    assert.equal(offSecond.resumedFromRunId, null);
    // Done with it: a real minute boundary would make it due again and its run would hold the
    // project during the next schedule's fires (skipped_busy, flaky on CI).
    t.scheduler.delete(off.id);

    // agent says nothing, schedule says resume_once with its own budget → resumed after a timeout
    const on = t.scheduler.create({
      name: "retry hang",
      agentId: "coder",
      prompt: "hang",
      cron: "* * * * *",
      onFailure: "resume_once",
      resumeBudgetUsd: 1,
    });
    const hung = await t.fireAndWait(on.id); // default_timeout_minutes 0.05 = 3 s
    assert.equal(hung.status, "timed_out");
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(on.id)).id, hung.id);
    const resumed = await t.fireAndWait(on.id);
    assert.equal(resumed.resumedFromRunId, hung.id);
    assert.match(resumed.prompt, /\(timed out\)/);
    assert.equal(
      resumed.command.argv[resumed.command.argv.indexOf("--max-budget-usd") + 1],
      "0.5",
      "$1 resume budget minus the default $0.50 reserve",
    );
    assert.equal(resumed.status, "completed");

    // clearing the schedule's policy falls back to the agent's (none for coder)
    t.scheduler.update(on.id, { onFailure: null, resumeBudgetUsd: null });
    assert.equal(t.repo.get(on.id).onFailure, null);
    assert.throws(
      () =>
        t.scheduler.create({
          name: "bad",
          agentId: "coder",
          prompt: "x",
          cron: "* * * * *",
          onFailure: "retry_forever",
        }),
      /on_failure must be one of/,
    );
    assert.throws(
      () => t.scheduler.create({ name: "bad2", agentId: "coder", prompt: "x", cron: "* * * * *", resumeBudgetUsd: -1 }),
      /resume_budget_usd must be/,
    );
  } finally {
    await t.close(root);
  }
});
