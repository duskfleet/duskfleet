/**
 * Monthly budgets per scope (global / agent / project): validation and one budget per scope,
 * spend counted from this UTC month's runs, a spent hard-stop budget refuses runs with
 * BudgetError and pauses the schedules of its scope (tick recorded as skipped_budget), and a
 * warn-only budget never refuses. Runs of unknown cost (cost_status unpriced, or still running)
 * count at a stand-in under unpriced_policy: count, and not at all under allow.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.js"; // drops an inherited CLAUDE_BIN before any executor is built
import {
  BudgetError,
  BusyError,
  ClaudeCodeExecutor,
  DailyCapError,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
  ScheduleRepository,
  Scheduler,
  utcMonthStart,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

// fake-claude reports $0.0123 per run.
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-budget-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const demo = path.join(root, "demo");
  const side = path.join(root, "side");
  mkdirSync(demo);
  mkdirSync(side);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nmax_concurrent_per_agent: 5\nmax_concurrent_per_project: 5\nscheduler:\n  enabled: true\n  tick_seconds: 5\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(
    path.join(configDir, "projects.yaml"),
    `projects:\n  demo:\n    path: ${demo}\n  side:\n    path: ${side}\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\nproject: demo\n---\nBe brief.\n`);
  writeFileSync(path.join(configDir, "agents", "helper.md"), `---\nproject: demo\n---\nHelp.\n`);
  writeFileSync(path.join(configDir, "agents", "other.md"), `---\nproject: side\n---\nElsewhere.\n`);
  writeFileSync(
    path.join(configDir, "agents", "capped.md"),
    `---\nproject: side\nmax_budget_usd: 0.25\n---\nCapped.\n`,
  );
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const scheduler = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const run = async (agentId, prompt = "ok") => {
    const r = await runs.startRun({ prompt, agentId });
    return runs.waitForRun(r.id, 15_000);
  };
  const close = async () => {
    scheduler.stop();
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { db, runs, repo, scheduler, run, close };
}

test("set_budget validation: scope ids must exist, amount > 0, warn_percent 1-100; one budget per scope", async () => {
  const t = setup();
  try {
    assert.throws(() => t.runs.setBudget({ scope: "agent", scopeId: "ghost", amountUsd: 1 }), /unknown agent: ghost/);
    assert.throws(() => t.runs.setBudget({ scope: "project", scopeId: "nope", amountUsd: 1 }), /unknown project: nope/);
    assert.throws(() => t.runs.setBudget({ scope: "agent", amountUsd: 1 }), /needs scope_id/);
    assert.throws(() => t.runs.setBudget({ scope: "global", scopeId: "x", amountUsd: 1 }), /takes no scope_id/);
    assert.throws(() => t.runs.setBudget({ scope: "global", amountUsd: 0 }), /amount_usd must be a number > 0/);
    assert.throws(
      () => t.runs.setBudget({ scope: "global", amountUsd: 1, warnPercent: 120 }),
      /warn_percent must be a whole number/,
    );
    assert.throws(() => t.runs.setBudget({ scope: "team", amountUsd: 1 }), /scope must be one of/);

    const first = t.runs.setBudget({ scope: "global", amountUsd: 10 });
    assert.equal(first.warnPercent, 80, "warn_percent defaults to 80");
    assert.equal(first.hardStop, true, "hard_stop defaults to true");
    assert.equal(first.state, "ok");
    const again = t.runs.setBudget({ scope: "global", amountUsd: 20, hardStop: false });
    assert.equal(again.id, first.id, "setting a scope's budget again replaces it");
    assert.equal(again.amountUsd, 20);
    assert.equal(again.hardStop, false);
    t.runs.setBudget({ scope: "agent", scopeId: "coder", amountUsd: 5 });
    assert.equal(t.runs.budgetStatuses().length, 2);
    assert.equal(t.runs.deleteBudget(first.id), true);
    assert.equal(t.runs.deleteBudget(first.id), false);
    assert.equal(t.runs.budgetStatuses().length, 1);
  } finally {
    await t.close();
  }
});

test("spend counts this UTC month only; warn from warn_percent, over at the amount", async () => {
  const t = setup();
  try {
    const old = await t.run("coder");
    t.db
      .prepare("UPDATE runs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.parse(utcMonthStart(new Date())) - 1000).toISOString(), old.id);
    t.runs.setBudget({ scope: "agent", scopeId: "coder", amountUsd: 0.015, warnPercent: 50 });
    let [s] = t.runs.budgetStatuses();
    assert.equal(s.spentUsd, 0, "last month's run is not counted");
    assert.equal(s.state, "ok");
    assert.equal(s.periodStart, utcMonthStart(new Date()));

    await t.run("coder");
    [s] = t.runs.budgetStatuses();
    assert.equal(s.spentUsd, 0.0123);
    assert.equal(s.percent, 82);
    assert.equal(s.state, "warn", "82% is past the 50% threshold, below the amount");

    await t.run("coder");
    [s] = t.runs.budgetStatuses();
    assert.equal(s.state, "over");
  } finally {
    await t.close();
  }
});

test("a spent hard-stop project budget refuses runs on the project and pauses its schedules; other scopes are untouched", async () => {
  const t = setup();
  try {
    const inScope = t.scheduler.create({ name: "coder hourly", agentId: "coder", prompt: "ok", cron: "0 * * * *" });
    const sibling = t.scheduler.create({ name: "helper hourly", agentId: "helper", prompt: "ok", cron: "0 * * * *" });
    const outside = t.scheduler.create({ name: "other hourly", agentId: "other", prompt: "ok", cron: "0 * * * *" });
    t.runs.setBudget({ scope: "project", scopeId: "demo", amountUsd: 0.02 });

    await t.run("coder");
    await t.run("helper");
    assert.equal(t.runs.budgetStatuses()[0].state, "over", "$0.0246 of $0.02");

    // The scheduler path: the due tick is refused, recorded as skipped_budget, and every
    // schedule of project demo (whatever its agent) is paused.
    t.repo.update(inScope.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await t.scheduler.tick();
    await t.scheduler.settled();
    const after = t.repo.get(inScope.id);
    assert.equal(after.lastOutcome, "skipped_budget");
    assert.match(after.lastError, /budget: the project demo budget is spent \(\$0\.0246 of \$0\.02 this month, UTC\)/);
    assert.match(after.lastError, /Paused 2 schedule\(s\) of that scope: coder hourly, helper hourly/);
    assert.equal(after.enabled, false, "paused");
    assert.equal(after.nextRunAt, null, "a paused schedule has no next run");
    assert.equal(t.repo.get(sibling.id).enabled, false, "the other schedule of the project is paused too");
    assert.equal(t.repo.get(outside.id).enabled, true, "a schedule on another project keeps running");

    await assert.rejects(t.runs.startRun({ prompt: "ok", agentId: "helper" }), (err) => {
      assert.ok(err instanceof BudgetError, "refused as BudgetError");
      assert.ok(!(err instanceof BusyError) && !(err instanceof DailyCapError), "neither busy nor a daily cap");
      return true;
    });
    assert.equal((await t.run("other")).status, "completed", "runs on another project still start");
  } finally {
    await t.close();
  }
});

test("a spent global budget refuses every run; a warn-only (hard_stop: false) budget never refuses", async () => {
  const t = setup();
  try {
    const budget = t.runs.setBudget({ scope: "global", amountUsd: 0.01, hardStop: false });
    await t.run("coder");
    assert.equal(t.runs.budgetStatuses()[0].state, "over");
    assert.equal((await t.run("other")).status, "completed", "warn only: still runs");

    t.runs.setBudget({ scope: "global", amountUsd: 0.01 });
    const s = t.scheduler.create({ name: "other hourly", agentId: "other", prompt: "ok", cron: "0 * * * *" });
    await assert.rejects(t.runs.startRun({ prompt: "ok", agentId: "other" }), BudgetError);
    assert.equal(t.repo.get(s.id).enabled, false, "the global budget pauses every schedule");
    assert.equal(t.runs.budgetReason({ agentId: "coder" }) !== null, true);

    t.runs.deleteBudget(budget.id);
    assert.equal(t.runs.budgetReason({ agentId: "coder" }), null, "no budget, no refusal");
    assert.equal(t.repo.get(s.id).enabled, false, "deleting the budget does not resume what it paused");
  } finally {
    await t.close();
  }
});

test("cost_status is settled with the run: reported / estimated by billing type, unpriced without a result", async () => {
  const t = setup();
  try {
    const priced = await t.run("coder");
    assert.equal(priced.costUsd, 0.0123);
    assert.equal(priced.costStatus, priced.billingType === "subscription" ? "estimated" : "reported");
    const crashed = await t.run("coder", "crash");
    assert.equal(crashed.costUsd, null);
    assert.equal(crashed.costStatus, "unpriced", "no result line: unpriced");
    assert.throws(
      () => t.runs.setBudget({ scope: "global", amountUsd: 1, unpricedPolicy: "ignore" }),
      /unpriced_policy must be one of count, allow/,
    );
    assert.equal(t.runs.setBudget({ scope: "global", amountUsd: 1 }).unpricedPolicy, "count", "count by default");
  } finally {
    await t.close();
  }
});

test("an unpriced run counts as its agent's max_budget_usd, or as the whole remaining budget; allow ignores it", async () => {
  const t = setup();
  try {
    const capped = await t.run("capped", "crash");
    assert.equal(capped.costStatus, "unpriced");
    t.runs.setBudget({ scope: "project", scopeId: "side", amountUsd: 1 });
    let [s] = t.runs.budgetStatuses();
    assert.equal(s.spentUsd, 0);
    assert.equal(s.unpricedRuns, 1);
    assert.equal(s.standInUsd, 0.25, "the agent's max_budget_usd stands in");
    assert.equal(s.countedUsd, 0.25);
    assert.equal(s.state, "ok");

    const sched = t.scheduler.create({ name: "other hourly", agentId: "other", prompt: "ok", cron: "0 * * * *" });
    await t.run("other", "crash"); // no max_budget_usd: the whole remaining budget
    [s] = t.runs.budgetStatuses();
    assert.equal(s.unpricedRuns, 2);
    assert.equal(s.countedUsd, 1);
    assert.equal(s.state, "over");
    assert.equal(s.overByRunning, false);
    await assert.rejects(t.runs.startRun({ prompt: "ok", agentId: "other" }), (err) => {
      assert.ok(err instanceof BudgetError);
      assert.match(
        err.message,
        /\$1 counted of \$1 this month, UTC: \$0 recorded plus \$1 standing in for 2 unpriced run/,
      );
      assert.match(err.message, /or set unpriced_policy: allow on it/);
      return true;
    });
    assert.equal(t.repo.get(sched.id).enabled, false, "settled over: the scope's schedules are paused");

    const unpriced = t.runs.unpricedRunsByBudget();
    assert.equal(unpriced.length, 1, "doctor lists the budget with unpriced runs");
    assert.deepEqual(
      unpriced[0].runs.map((r) => [r.agentId, r.standInUsd]),
      [
        ["capped", 0.25],
        ["other", null],
      ],
    );

    t.runs.setBudget({ scope: "project", scopeId: "side", amountUsd: 1, unpricedPolicy: "allow" });
    [s] = t.runs.budgetStatuses();
    assert.equal(s.unpricedRuns, 2, "still reported");
    assert.equal(s.standInUsd, 0);
    assert.equal(s.state, "ok", "allow: unknown costs do not count");
    assert.equal((await t.run("other")).status, "completed");
  } finally {
    await t.close();
  }
});

test("a running run counts at its stand-in: refused while it runs, without pausing schedules", async () => {
  const t = setup();
  try {
    const sched = t.scheduler.create({ name: "other hourly", agentId: "other", prompt: "ok", cron: "0 * * * *" });
    t.runs.setBudget({ scope: "project", scopeId: "side", amountUsd: 0.2 });
    const going = await t.runs.startRun({ prompt: "hang", agentId: "capped" });
    let [s] = t.runs.budgetStatuses();
    assert.equal(s.runningRuns, 1);
    assert.equal(s.standInUsd, 0.25);
    assert.equal(s.state, "over");
    assert.equal(s.overByRunning, true);
    await assert.rejects(t.runs.startRun({ prompt: "ok", agentId: "other" }), (err) => {
      assert.ok(err instanceof BudgetError);
      assert.match(err.message, /hard_stop refuses new runs until they end/);
      return true;
    });
    assert.equal(t.repo.get(sched.id).enabled, true, "over only by a running run: nothing paused");
    t.runs.cancelRun(going.id);
    await t.runs.waitForRun(going.id, 15_000);
    [s] = t.runs.budgetStatuses();
    assert.equal(s.runningRuns, 0);
    assert.equal(s.unpricedRuns, 1, "cancelled without a result: unpriced");
  } finally {
    await t.close();
  }
});

test("migration 25 backfills cost_status of finished runs; old unpriced rows of the month count", async () => {
  const t = setup();
  try {
    const priced = await t.run("other");
    const crashed = await t.run("other", "crash");
    t.db.prepare("UPDATE runs SET billing_type = 'subscription' WHERE id = ?").run(priced.id);
    // Back to schema 24, as an upgraded installation would be.
    t.db.exec(
      "ALTER TABLE runs DROP COLUMN cost_status; ALTER TABLE budgets DROP COLUMN unpriced_policy; DELETE FROM schema_migrations WHERE version = 25;",
    );
    const dataDir = path.dirname(t.db.prepare("PRAGMA database_list").get().file);
    const db = openDatabase(dataDir);
    try {
      const rows = new RunRepository(db);
      assert.equal(rows.get(priced.id).costStatus, "estimated", "subscription: estimated");
      assert.equal(rows.get(crashed.id).costStatus, "unpriced");
      rows.budgets.upsert({
        scope: "global",
        scopeId: null,
        amountUsd: 5,
        warnPercent: 80,
        hardStop: true,
        unpricedPolicy: "count",
      });
      assert.deepEqual(
        rows.budgets.unknownCostSince({ scope: "global", scopeId: null }, utcMonthStart(new Date())).map((r) => r.id),
        [crashed.id],
      );
    } finally {
      db.close();
    }
  } finally {
    await t.close();
  }
});
