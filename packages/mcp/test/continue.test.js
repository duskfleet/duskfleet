/**
 * Continuing a run's Claude session (#60): run_agent { resume_run_id } through
 * RunManager.continueRun, a schedule's `continue: true`, the match check (agent, project path,
 * agent hash), the runs that cannot be continued, and the fallback to a fresh session when
 * Claude Code no longer has the session (the verified unknown-session shape in fake-claude.js).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import {
  ClaudeCodeExecutor,
  continueMismatch,
  continueRefusal,
  createStreamState,
  ingestLine,
  isSessionNotFound,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
  ScheduleRepository,
  Scheduler,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

function makeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-continue-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  const other = path.join(root, "other");
  mkdirSync(project);
  mkdirSync(other);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nscheduler:\n  enabled: true\n  tick_seconds: 5\n  defer_busy: false\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.5\n  env_passthrough: ["FAKE_CLAUDE_*"]\n`,
  );
  writeFileSync(
    path.join(configDir, "projects.yaml"),
    `projects:\n  demo:\n    path: ${project}\n  other:\n    path: ${other}\n`,
  );
  const agentFile = path.join(configDir, "agents", "coder.md");
  writeFileSync(agentFile, `---\nproject: demo\n---\nBe brief.\n`);
  writeFileSync(path.join(configDir, "agents", "helper.md"), `---\nproject: demo\n---\nHelp.\n`);
  writeFileSync(path.join(configDir, "agents", "free.md"), `---\n---\nUnbound.\n`);
  writeFileSync(
    path.join(configDir, "agents", "resumer.md"),
    `---\nproject: demo\nmax_budget_usd: 2\nwrap_up_reserve_usd: 0\non_failure: resume_once\n---\nRetry once.\n`,
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
  const fireAndWait = async (id) => {
    repo.update(id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await scheduler.tick();
    await scheduler.settled();
    return runs.waitForRun(repo.get(id).lastRunId, 15_000);
  };
  const notes = (runId) =>
    runs
      .events(runId)
      .filter((e) => e.type === "note")
      .map((e) => e.payload);
  const cleanup = async () => {
    scheduler.stop();
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, agentFile, project: realpathSync(project), runs, repo, scheduler, fireAndWait, notes, cleanup };
}

const argAfter = (run, flag) => {
  const argv = run.command.argv;
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

test("continueRun resumes the session of an ended run with the new prompt; a continuation can be continued again", async () => {
  const app = makeApp();
  try {
    const first = await app.runs.waitForRun((await app.runs.startRun({ prompt: "ok", agentId: "coder" })).id, 10_000);
    assert.equal(first.status, "completed");
    assert.equal(first.continuedFromRunId, null);

    const started = await app.runs.continueRun({ runId: first.id, prompt: "next step" });
    const second = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(second.status, "completed");
    assert.equal(second.continuedFromRunId, first.id);
    assert.equal(second.resumedFromRunId, null, "not the on_failure retry");
    assert.equal(second.retries, 0, "a continuation is not a retry");
    assert.equal(second.prompt, "next step");
    assert.equal(second.agentId, "coder", "the original run's agent by default");
    assert.equal(second.projectId, "demo", "the original run's project by default");
    assert.equal(second.claudeSessionId, first.claudeSessionId);
    assert.equal(argAfter(second, "--resume"), first.claudeSessionId);
    assert.ok(!second.command.argv.includes("--session-id"));
    assert.ok(app.notes(second.id).some((n) => n.continuedFromRunId === first.id));
    assert.ok(app.notes(first.id).some((n) => n.message === `continued by run ${second.id}`));

    // a chain, and the same run continued twice: no unique link
    const third = await app.runs.waitForRun(
      (await app.runs.continueRun({ runId: second.id, prompt: "ok" })).id,
      10_000,
    );
    assert.equal(third.continuedFromRunId, second.id);
    assert.equal(third.claudeSessionId, first.claudeSessionId);
    const again = await app.runs.waitForRun((await app.runs.continueRun({ runId: first.id, prompt: "ok" })).id, 10_000);
    assert.equal(again.continuedFromRunId, first.id);
    assert.deepEqual(
      app.runs.continuedBy(first.id).map((r) => r.id),
      [second.id, again.id],
    );
    assert.equal(app.runs.resumedBy(first.id), null, "the resume_once link is untouched");
  } finally {
    await app.cleanup();
  }
});

test("continueRun refuses unknown, running, cancelled and context-exhausted runs", async () => {
  const app = makeApp();
  try {
    await assert.rejects(() => app.runs.continueRun({ runId: "nope", prompt: "ok" }), /run not found: nope/);

    const hanging = await app.runs.startRun({ prompt: "hang", agentId: "coder" });
    await assert.rejects(
      () => app.runs.continueRun({ runId: hanging.id, prompt: "ok" }),
      /cannot continue: run .* is still running/,
    );
    app.runs.cancelRun(hanging.id);
    const cancelled = await app.runs.waitForRun(hanging.id, 10_000);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(() => app.runs.continueRun({ runId: cancelled.id, prompt: "ok" }), /was cancelled/);

    const full = await app.runs.waitForRun(
      (await app.runs.startRun({ prompt: "max-turns", agentId: "coder" })).id,
      10_000,
    );
    assert.equal(full.contextExhausted, true);
    await assert.rejects(() => app.runs.continueRun({ runId: full.id, prompt: "ok" }), /exhausted its context/);

    // a failed run can be continued (any terminal run with a session, except the two above)
    const failed = await app.runs.waitForRun(
      (await app.runs.startRun({ prompt: "error", agentId: "coder" })).id,
      10_000,
    );
    assert.equal(failed.status, "failed");
    assert.equal(continueRefusal(failed), null);
  } finally {
    await app.cleanup();
  }
});

test("a continuation whose agent, project or agent definition changed starts a fresh session with a note", async () => {
  const app = makeApp();
  try {
    const first = await app.runs.waitForRun((await app.runs.startRun({ prompt: "ok", agentId: "coder" })).id, 10_000);

    const otherAgent = await app.runs.waitForRun(
      (await app.runs.continueRun({ runId: first.id, prompt: "ok", agentId: "helper" })).id,
      10_000,
    );
    assert.equal(otherAgent.status, "completed");
    assert.equal(otherAgent.continuedFromRunId, null);
    assert.notEqual(otherAgent.claudeSessionId, first.claudeSessionId);
    assert.ok(otherAgent.command.argv.includes("--session-id"));
    assert.ok(!otherAgent.command.argv.includes("--resume"));
    const note = app.notes(otherAgent.id).find((n) => n.notContinuedFromRunId === first.id);
    assert.match(note.message, /started a fresh session: .*agent coder, now helper/);

    writeFileSync(app.agentFile, `---\nproject: demo\n---\nBe briefer.\n`);
    const edited = await app.runs.waitForRun(
      (await app.runs.continueRun({ runId: first.id, prompt: "ok" })).id,
      10_000,
    );
    assert.equal(edited.continuedFromRunId, null);
    assert.ok(edited.command.argv.includes("--session-id"));
    assert.ok(app.notes(edited.id).some((n) => /the agent definition changed since/.test(n.message)));

    // the rule itself
    const from = { agentId: "a", projectPath: "/p", agentHash: "h" };
    assert.equal(continueMismatch(from, "a", "/p", "h"), null);
    assert.match(continueMismatch(from, "a", "/q", "h"), /project path \/p, now \/q/);
    assert.match(continueMismatch({ ...from, agentHash: null }, "a", "/p", "h"), /no agent hash/);
  } finally {
    await app.cleanup();
  }
});

test("a session Claude Code no longer has falls back to a fresh session once, with a note", async () => {
  const app = makeApp();
  try {
    const first = await app.runs.waitForRun((await app.runs.startRun({ prompt: "ok", agentId: "coder" })).id, 10_000);
    process.env.FAKE_CLAUDE_RESUME = "unknown-session";
    const run = await app.runs.waitForRun((await app.runs.continueRun({ runId: first.id, prompt: "ok" })).id, 15_000);
    assert.equal(run.status, "completed", "the fresh session ran the prompt");
    assert.equal(run.continuedFromRunId, null, "it did not continue anything in the end");
    assert.notEqual(run.claudeSessionId, first.claudeSessionId);
    assert.ok(run.command.argv.includes("--session-id"), "the recorded command is the fresh one");
    assert.equal(run.costUsd, 0.0123, "only the fresh session's result is recorded");
    assert.equal(run.phases.length, 1, "the failed attempt is not a phase");
    const note = app.notes(run.id).find((n) => n.notContinuedFromRunId === first.id);
    assert.match(note.message, /unknown to Claude Code \(No conversation found\): started a fresh session/);
  } finally {
    delete process.env.FAKE_CLAUDE_RESUME;
    await app.cleanup();
  }
});

test("isSessionNotFound reads the verified result line, nothing else", () => {
  const parse = (line) => {
    const state = createStreamState();
    ingestLine(state, JSON.stringify(line));
    return state.result;
  };
  const id = "00000000-0000-4000-8000-000000000000";
  const unknown = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    session_id: id,
    total_cost_usd: 0,
    errors: [`No conversation found with session ID: ${id}`],
  };
  assert.equal(isSessionNotFound(parse(unknown)), true);
  assert.equal(isSessionNotFound(parse({ ...unknown, num_turns: 3 })), false, "a model turn happened");
  assert.equal(isSessionNotFound(parse({ ...unknown, errors: ["something else"] })), false);
  assert.equal(isSessionNotFound(parse({ ...unknown, subtype: "error_max_turns" })), false);
  assert.equal(isSessionNotFound(null), false);
});

test("schedule continue: true continues the last ended run; resume_once wins after a budget failure", async () => {
  const app = makeApp();
  try {
    const s = app.scheduler.create({
      name: "chain",
      agentId: "coder",
      prompt: "ok",
      cron: "* * * * *",
      continueSession: true,
    });
    assert.equal(app.repo.get(s.id).continueSession, true);
    const first = await app.fireAndWait(s.id);
    assert.equal(first.continuedFromRunId, null, "nothing to continue before the first run");
    assert.ok(first.command.argv.includes("--session-id"));

    const second = await app.fireAndWait(s.id);
    assert.equal(second.continuedFromRunId, first.id);
    assert.equal(argAfter(second, "--resume"), first.claudeSessionId);
    assert.equal(second.prompt, "ok", "the schedule's own prompt");
    assert.equal(app.repo.get(s.id).lastOutcome, "started");

    // a failed last run is continued too (whatever its outcome); coder has no on_failure policy
    process.env.FAKE_CLAUDE_RESUME = "budget";
    const failed = await app.fireAndWait(s.id);
    delete process.env.FAKE_CLAUDE_RESUME;
    assert.equal(failed.status, "failed");
    assert.equal(failed.continuedFromRunId, second.id);
    const afterFailure = await app.fireAndWait(s.id);
    assert.equal(afterFailure.continuedFromRunId, failed.id);

    // an agent edit: fresh session plus a note, never a skipped tick
    writeFileSync(app.agentFile, `---\nproject: demo\n---\nBe briefer.\n`);
    const edited = await app.fireAndWait(s.id);
    assert.equal(edited.status, "completed");
    assert.equal(edited.continuedFromRunId, null);
    assert.ok(app.notes(edited.id).some((n) => n.notContinuedFromRunId === afterFailure.id));

    // turning it off: fresh sessions again
    app.scheduler.update(s.id, { continueSession: false });
    const off = await app.fireAndWait(s.id);
    assert.equal(off.continuedFromRunId, null);
    assert.equal(
      app.notes(off.id).some((n) => n.notContinuedFromRunId),
      false,
    );

    // resume_once first, continue from the next fire
    const r = app.scheduler.create({
      name: "retry then chain",
      agentId: "resumer",
      prompt: "budget",
      cron: "* * * * *",
      continueSession: true,
    });
    const budget = await app.fireAndWait(r.id);
    assert.equal(budget.terminationReason, "budget_exhausted");
    const resumed = await app.fireAndWait(r.id);
    assert.equal(resumed.resumedFromRunId, budget.id, "resume_once wins");
    assert.equal(resumed.continuedFromRunId, null);
    assert.equal(app.repo.get(r.id).lastOutcome, "resumed");
    const next = await app.fireAndWait(r.id);
    assert.equal(next.continuedFromRunId, resumed.id, "continue applies again from the next fire");
    assert.equal(next.resumedFromRunId, null);
  } finally {
    delete process.env.FAKE_CLAUDE_RESUME;
    await app.cleanup();
  }
});

test("schedule continue: a cancelled or context-exhausted last run gets a fresh session plus a note", async () => {
  const app = makeApp();
  try {
    const s = app.scheduler.create({
      name: "full",
      agentId: "coder",
      prompt: "max-turns",
      cron: "* * * * *",
      continueSession: true,
    });
    const full = await app.fireAndWait(s.id);
    assert.equal(full.contextExhausted, true);
    app.scheduler.update(s.id, { prompt: "ok" });
    const fresh = await app.fireAndWait(s.id);
    assert.equal(fresh.status, "completed");
    assert.equal(fresh.continuedFromRunId, null);
    assert.ok(fresh.command.argv.includes("--session-id"));
    assert.ok(app.notes(fresh.id).some((n) => /exhausted its context/.test(n.message)));
    assert.throws(() => app.scheduler.update(s.id, { continueSession: "yes" }), /continue must be true or false/);
  } finally {
    await app.cleanup();
  }
});
