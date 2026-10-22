/**
 * Monthly budgets per scope (global / agent / project): validation and one budget per scope,
 * spend counted from this UTC month's runs, a spent hard-stop budget refuses runs with
 * BudgetError and pauses the schedules of its scope (tick recorded as skipped_budget), and a
 * warn-only budget never refuses.
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
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  const repo = new ScheduleRepository(db);
  const scheduler = new Scheduler(repo, runs, { tickMs: 1000, holder: "A" });
  const run = async (agentId) => {
    const r = await runs.startRun({ prompt: "ok", agentId });
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
