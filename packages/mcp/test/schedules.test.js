/**
 * Scheduler: CRUD over MCP, a due schedule fires through RunManager on tick,
 * busy agents are skipped (not queued), the kill switch stops firing, and two
 * processes cannot both hold the lease.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ClaudeCodeExecutor, RunManager, RunRepository, ScheduleRepository, Scheduler, loadConfig, openDatabase } from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-sched-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(path.join(configDir, "duskfleet.yaml"), `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: true\n  tick_seconds: 5\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`);
  writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  demo:\n    path: ${project}\n`);
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\nproject: demo\n---\nBe brief.\n`);
  writeFileSync(path.join(configDir, "agents", "free.md"), `---\n---\nUnbound.\n`);
  writeFileSync(path.join(configDir, "agents", "resumer.md"), `---\nproject: demo\nmax_budget_usd: 2\nwrap_up_reserve_usd: 0\non_failure: resume_once\nresume_budget_usd: 3\n---\nRetry once.\n`);
  return { root, configDir, project: realpathSync(project) };
}

function makeScheduler(configDir) {
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(config, new RunRepository(db), new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }));
  const repo = new ScheduleRepository(db);
  const scheduler = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const due = (id) => repo.update(id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  const fireAndWait = async (id) => {
    due(id);
    await scheduler.tick();
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
  return { config, db, runs, repo, scheduler, due, fireAndWait, close };
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
    env: { ...process.env, DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" },
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["list_schedules", "create_schedule", "update_schedule", "delete_schedule", "run_schedule_now"]) assert.ok(tools.includes(t), t);

    const created = ok(await client.callTool({ name: "create_schedule", arguments: { name: "coder hourly", agent_id: "coder", prompt: "ok", cron: "0 8-20 * * 1-5" } }));
    assert.equal(created.schedule.timeZone, "Europe/London");
    assert.equal(created.schedule.cronHuman, "weekdays 08–20 at :00");
    assert.equal(created.schedule.projectId, null, "bound agent: project comes from the agent");
    assert.ok(created.schedule.nextRunAt, "next_run_at computed");
    assert.equal(created.schedule.enabled, true);

    fails(await client.callTool({ name: "create_schedule", arguments: { name: "coder hourly", agent_id: "coder", prompt: "ok", cron: "0 * * * *" } }), /already exists/);
    fails(await client.callTool({ name: "create_schedule", arguments: { name: "bad cron", agent_id: "coder", prompt: "ok", cron: "0 8" } }), /5 fields/);
    fails(await client.callTool({ name: "create_schedule", arguments: { name: "bad tz", agent_id: "coder", prompt: "ok", cron: "0 * * * *", time_zone: "Mars/Olympus" } }), /unknown time zone/);
    fails(await client.callTool({ name: "create_schedule", arguments: { name: "no project", agent_id: "free", prompt: "ok", cron: "0 * * * *" } }), /not bound to a project; pass project_id/);
    fails(await client.callTool({ name: "create_schedule", arguments: { name: "no agent", agent_id: "ghost", prompt: "ok", cron: "0 * * * *" } }), /unknown agent/);

    const listed = ok(await client.callTool({ name: "list_schedules", arguments: {} }));
    assert.equal(listed.schedules.length, 1);
    assert.equal(listed.scheduler.enabled, true);
    assert.equal(listed.scheduler.running, true, "the MCP server ticks");

    const paused = ok(await client.callTool({ name: "update_schedule", arguments: { id: created.schedule.id, enabled: false } }));
    assert.equal(paused.schedule.enabled, false);
    assert.equal(paused.schedule.nextRunAt, null, "paused schedules have no next run");
    const resumed = ok(await client.callTool({ name: "update_schedule", arguments: { id: created.schedule.id, enabled: true, cron: "30 9 * * 1-5", model: "haiku" } }));
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
    const withPolicy = ok(await client.callTool({ name: "update_schedule", arguments: { id: created.schedule.id, on_failure: "resume_once", resume_budget_usd: 2 } }));
    assert.equal(withPolicy.schedule.onFailure, "resume_once");
    assert.equal(withPolicy.schedule.effectiveOnFailure, "resume_once");
    assert.equal(withPolicy.schedule.willResumeRunId, budgetFire.runId, "list_schedules says what the next tick will do");
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
    const cleared = ok(await client.callTool({ name: "update_schedule", arguments: { id: created.schedule.id, clear_on_failure: true } }));
    assert.equal(cleared.schedule.onFailure, null);
    assert.equal(cleared.schedule.effectiveOnFailure, "none", "back to the agent's policy");
    assert.equal(cleared.schedule.willResumeRunId, null);

    const deleted = ok(await client.callTool({ name: "delete_schedule", arguments: { id: created.schedule.id } }));
    assert.equal(deleted.deleted, true);
    fails(await client.callTool({ name: "delete_schedule", arguments: { id: created.schedule.id } }), /not found/);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tick fires due schedules, honours the kill switch, and only the lease holder fires", async () => {
  const { root, configDir, project } = makeRoot();
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(config, new RunRepository(db), new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }));
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

    // kill switch
    writeFileSync(path.join(configDir, "duskfleet.yaml"), `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: false\nclaude:\n  binary: "${fakeBinary}"\n`);
    await runs.waitForRun(after.lastRunId, 10_000);
    repo.update(s.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await a.tick();
    assert.equal(repo.get(s.id).fires, 1, "nothing fires with the kill switch on");
    assert.equal(a.status().enabled, false);
    assert.equal(a.status().leaseHeldByThisProcess, false, "lease released");

    // with A gone, B takes over
    writeFileSync(path.join(configDir, "duskfleet.yaml"), `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: true\nclaude:\n  binary: "${fakeBinary}"\n`);
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

test("a run request (dashboard 'Run now') is fired by the lease holder on its next tick, even when paused, and cleared", async () => {
  const { root, configDir } = makeRoot();
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(config, new RunRepository(db), new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }));
  const repo = new ScheduleRepository(db);
  const a = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const b = new Scheduler(repo, runs, { tickMs: 1000, holder: "B" });
  try {
    const s = a.create({ name: "paused one", agentId: "coder", prompt: "ok", cron: "0 3 * * *", enabled: false });
    assert.equal(s.runRequestedAt, null);

    // the request is a timestamp on the row, idempotent
    const requested = repo.requestRun(s.id);
    assert.ok(requested.runRequestedAt);
    assert.equal(repo.requestRun(s.id).runRequestedAt, requested.runRequestedAt, "second request keeps the first timestamp");
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
  const runs = new RunManager(config, new RunRepository(db), new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }));
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
  const child = spawn(process.execPath, [cliEntry, "serve"], { env: { ...process.env, DUSKFLEET_CONFIG: configDir }, stdio: ["ignore", "pipe", "pipe"] });
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
    assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "3", "resume_budget_usd, with the agent's wrap-up reserve of 0");
    assert.match(second.prompt, /^Your previous session ended early \(budget exhausted\)/);
    assert.equal(second.status, "completed", "the fake's --resume branch finishes the job");
    assert.equal(t.runs.resumedBy(first.id).id, second.id);
    const sched = t.repo.get(s.id);
    assert.equal(sched.lastOutcome, "resumed");
    assert.equal(sched.fires, 2, "a resume is a fire");
    assert.deepEqual(t.repo.firings(s.id).map((f) => f.outcome), ["resumed", "started"]);
    const notes = t.runs.events(first.id).filter((e) => e.type === "note").map((e) => e.payload.message);
    assert.ok(notes.some((m) => m === `resumed by run ${second.id}`), "the original run's timeline links to the retry");
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
  } finally {
    delete process.env.FAKE_CLAUDE_RESUME;
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
    assert.equal(idle.noopRuns, 2, "'Nothing to do: no tickets in Ready.' matches the default marker; 'Done' and the failed run do not");
    assert.equal(idle.noopCostUsd, 0.0246);
    assert.equal(idle.noopPattern, "/nothing to do|no .* in ready/i");
    assert.ok(idle.costUsd >= 0.0369);

    // A schedule-specific marker replaces the default; an invalid one is refused.
    t.scheduler.update(s.id, { noopPattern: "created hello" });
    assert.equal(t.scheduler.idleStats(t.repo.get(s.id)).noopRuns, 1);
    assert.throws(() => t.scheduler.update(s.id, { noopPattern: "/(unclosed/" }), /invalid noop_pattern/);
    // Outside the window nothing counts.
    assert.equal(t.scheduler.idleStats(t.repo.get(s.id), 0).runs, 0);
    const hung = t.runs.listRuns({ status: "running" })[0];
    if (hung) t.runs.cancelRun(hung.id);
  } finally {
    await t.close(root);
  }
});

test("a timed-out run is resumed too; a schedule's on_failure overrides the agent's in both directions", async () => {
  const { root, configDir } = makeRoot();
  const t = makeScheduler(configDir);
  try {
    // agent says resume_once, schedule says none → fresh
    const off = t.scheduler.create({ name: "no retry", agentId: "resumer", prompt: "budget", cron: "* * * * *", onFailure: "none" });
    const offFirst = await t.fireAndWait(off.id);
    assert.equal(offFirst.status, "failed");
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(off.id)), null);
    const offSecond = await t.fireAndWait(off.id);
    assert.equal(offSecond.resumedFromRunId, null);

    // agent says nothing, schedule says resume_once with its own budget → resumed after a timeout
    const on = t.scheduler.create({ name: "retry hang", agentId: "coder", prompt: "hang", cron: "* * * * *", onFailure: "resume_once", resumeBudgetUsd: 1 });
    const hung = await t.fireAndWait(on.id); // default_timeout_minutes 0.05 = 3 s
    assert.equal(hung.status, "timed_out");
    assert.equal(t.scheduler.resumeCandidate(t.repo.get(on.id)).id, hung.id);
    const resumed = await t.fireAndWait(on.id);
    assert.equal(resumed.resumedFromRunId, hung.id);
    assert.match(resumed.prompt, /\(timed out\)/);
    assert.equal(resumed.command.argv[resumed.command.argv.indexOf("--max-budget-usd") + 1], "0.5", "$1 resume budget minus the default $0.50 reserve");
    assert.equal(resumed.status, "completed");

    // clearing the schedule's policy falls back to the agent's (none for coder)
    t.scheduler.update(on.id, { onFailure: null, resumeBudgetUsd: null });
    assert.equal(t.repo.get(on.id).onFailure, null);
    assert.throws(() => t.scheduler.create({ name: "bad", agentId: "coder", prompt: "x", cron: "* * * * *", onFailure: "retry_forever" }), /on_failure must be one of/);
    assert.throws(() => t.scheduler.create({ name: "bad2", agentId: "coder", prompt: "x", cron: "* * * * *", resumeBudgetUsd: -1 }), /resume_budget_usd must be/);
  } finally {
    await t.close(root);
  }
});
