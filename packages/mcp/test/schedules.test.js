/**
 * Scheduler: CRUD over MCP, a due schedule fires through RunManager on tick,
 * busy agents are skipped (not queued), the kill switch stops firing, and two
 * processes cannot both hold the lease.
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
  openDatabase,
  RunManager,
  RunRepository,
  ScheduleRepository,
  Scheduler,
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
  return { root, configDir, project: realpathSync(project) };
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
