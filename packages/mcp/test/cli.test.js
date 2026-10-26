/**
 * CLI: `run --project` accepts a registered project id as well as an absolute path.
 * The id-vs-path decision is core's (RunManager.resolveProject), so MCP's project_path behaves the same.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, openDatabase, RunRepository, ScheduleRepository } from "@duskfleet/core";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const cliEntry = path.join(here, "..", "dist", "cli.js");

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-cli-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  // JSON strings are valid YAML: paths with quotes, `: `, `#` or backslashes stay intact.
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nclaude:\n  binary: ${JSON.stringify(fakeBinary)}\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(
    path.join(configDir, "projects.yaml"),
    `projects:\n  demo:\n    path: ${JSON.stringify(realpathSync(project))}\n`,
  ); // resolved: core matches path-launched runs to projects by exact path
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  return { root, configDir, project: realpathSync(project) };
}

function cli(configDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn", ...extraEnv }),
    encoding: "utf8",
  });
}

test("cli run --project accepts a registered id or a path; unknown ids, relative paths and both flags fail clearly", () => {
  const { root, configDir, project } = makeRoot();
  try {
    const byId = cli(configDir, ["run", "--project", "demo", "--", "hello"]);
    assert.equal(byId.status, 0, byId.stderr);
    const run = JSON.parse(byId.stdout);
    assert.equal(run.projectId, "demo");
    assert.equal(run.projectPath, project);

    const byPath = cli(configDir, ["run", "--project", project, "--", "hello"]);
    assert.equal(byPath.status, 0, byPath.stderr);
    assert.equal(JSON.parse(byPath.stdout).projectId, "demo", "a registered path still resolves to its id");

    const unknown = cli(configDir, ["run", "--project", "nope", "--", "hello"]);
    assert.notEqual(unknown.status, 0);
    assert.match(
      unknown.stderr,
      /unknown project "nope"\. Known projects: demo/,
      "a value that is not path-like is an id",
    );

    const relative = cli(configDir, ["run", "--project", "./project", "--", "hello"]);
    assert.notEqual(relative.status, 0);
    assert.match(relative.stderr, /project path must be absolute: \.\/project/);

    const both = cli(configDir, ["run", "--project", "demo", "--project-id", "demo", "--", "hello"]);
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /mutually exclusive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor --probe makes one haiku run outside any project, says it costs money and reports failures", () => {
  const { root, configDir } = makeRoot();
  try {
    const plain = cli(configDir, ["doctor"]);
    assert.equal(plain.status, 0, plain.stderr);
    const plainReport = JSON.parse(plain.stdout);
    assert.equal("probe" in plainReport, false, "no probe without the flag");
    assert.equal(typeof plainReport.path, "string", "doctor prints the effective PATH");
    assert.equal(typeof plainReport.pathDefaulted, "boolean");
    assert.doesNotMatch(plain.stderr, /costs/);

    const ok = cli(configDir, ["doctor", "--probe"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /one real Claude run on haiku \(costs a few cents/);
    const report = JSON.parse(ok.stdout);
    assert.equal(report.probe.ok, true);
    assert.equal(report.probe.outcome, "completed");
    assert.equal(report.probe.model, "haiku", "the probe always runs on haiku");
    assert.equal(report.probe.costUsd, 0.0123);
    assert.equal(report.probe.advice, null);
    assert.match(report.probe.note, /costs/);
    const runs = JSON.parse(cli(configDir, ["runs"]).stdout);
    assert.equal(runs.length, 0, "the probe is a diagnostic, not a recorded run");

    const auth = cli(configDir, ["doctor", "--probe"], { FAKE_CLAUDE_MODE: "auth" });
    assert.equal(auth.status, 1);
    const authProbe = JSON.parse(auth.stdout).probe;
    assert.equal(authProbe.ok, false);
    assert.equal(authProbe.outcome, "failed");
    assert.match(authProbe.error, /Please run \/login/);
    assert.match(authProbe.advice, /not authenticated/);

    // default_timeout_minutes is 0.05 here, below the probe's 2 minute ceiling.
    const hang = cli(configDir, ["doctor", "--probe"], { FAKE_CLAUDE_MODE: "hang" });
    assert.equal(hang.status, 1);
    const hangProbe = JSON.parse(hang.stdout).probe;
    assert.equal(hangProbe.outcome, "timed_out");
    assert.match(hangProbe.advice, /no result within 3 s: a hook or a prompt is likely blocking/);

    const noVersion = cli(configDir, ["doctor", "--probe"], { FAKE_CLAUDE_MODE: "no-version" });
    assert.equal(noVersion.status, 1);
    assert.match(noVersion.stderr, /doctor --probe skipped: claude --version failed/);
    assert.doesNotMatch(noVersion.stderr, /costs a few cents/, "nothing is spent when the probe is skipped");
    const skipped = JSON.parse(noVersion.stdout).probe;
    assert.equal(skipped.ok, false);
    assert.equal(skipped.outcome, "skipped");

    // mkdtempSync under a missing TMPDIR throws inside runProbe: doctor still prints its report.
    const thrown = cli(configDir, ["doctor", "--probe"], { TMPDIR: path.join(root, "missing-tmp") });
    assert.equal(thrown.status, 1);
    const thrownReport = JSON.parse(thrown.stdout);
    assert.equal(thrownReport.claudeVersion, "9.9.9 (fake)");
    assert.equal(thrownReport.probe.ok, false);
    assert.equal(thrownReport.probe.outcome, "error");
    assert.match(thrownReport.probe.error, /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor --probe on Ctrl-C cancels the paid child, removes its temp dir and exits 130", async () => {
  const { root, configDir } = makeRoot();
  const probeTmp = path.join(root, "tmp");
  mkdirSync(probeTmp);
  try {
    const child = spawn(process.execPath, [cliEntry, "doctor", "--probe"], {
      env: testEnv({
        DUSKFLEET_CONFIG: configDir,
        DUSKFLEET_LOG_LEVEL: "warn",
        FAKE_CLAUDE_MODE: "hang",
        TMPDIR: probeTmp,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    await new Promise((resolve) => {
      child.stderr.on("data", (d) => {
        stderr += d;
        if (/costs a few cents/.test(stderr)) resolve();
      });
    });
    // The note is written just before the probe spawns the fake child; give it a moment to start.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(readdirSync(probeTmp).filter((f) => f.startsWith("duskfleet-probe-")).length, 1);
    // A second Ctrl-C right after the first must not kill doctor before its cleanup.
    child.kill("SIGINT");
    child.kill("SIGINT");
    const { code, signal } = await exited;
    assert.equal(signal, null, stderr);
    assert.equal(code, 130, stderr);
    assert.equal(stderr.match(/doctor --probe interrupted: cancelling the probe run/g)?.length, 1, stderr);
    assert.equal(stdout, "", "an interrupted doctor prints no report");
    assert.deepEqual(
      readdirSync(probeTmp).filter((f) => f.startsWith("duskfleet-probe-")),
      [],
      "the temp dir is removed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli schedules run-now stamps run_requested_at by id or name and spawns nothing; unknown targets fail", () => {
  const { root, configDir } = makeRoot();
  try {
    const config = loadConfig(configDir);
    const db = openDatabase(config.dataDir);
    const repo = new ScheduleRepository(db);
    const s = repo.insert({
      name: "pr review",
      agentId: "coder",
      projectId: "demo",
      prompt: "ok",
      cron: "0 9 * * *",
      timeZone: "UTC",
      enabled: false,
      nextRunAt: null,
    });
    db.close();

    const byName = cli(configDir, ["schedules", "run-now", "pr review"]);
    assert.equal(byName.status, 0, byName.stderr);
    assert.ok(JSON.parse(byName.stdout).runRequestedAt, "the request is stamped, even on a paused schedule");
    assert.match(
      byName.stderr,
      /nothing is ticking/,
      "a CLI process never ticks, so it tells the caller who will fire it",
    );

    const byId = cli(configDir, ["schedules", "run-now", s.id]);
    assert.equal(byId.status, 0, byId.stderr);
    assert.equal(
      JSON.parse(byId.stdout).runRequestedAt,
      JSON.parse(byName.stdout).runRequestedAt,
      "idempotent: the first timestamp is kept",
    );

    const db2 = openDatabase(config.dataDir);
    assert.equal(new RunRepository(db2).list({}).length, 0, "run-now does not start a run itself");
    db2.close();

    const unknown = cli(configDir, ["schedules", "run-now", "nope"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /schedule not found: nope/);

    const noTarget = cli(configDir, ["schedules", "run-now"]);
    assert.equal(noTarget.status, 2, "usage error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh clone: no config/agents directory at all, default_agent null, claude found through CLAUDE_BIN. */
function makeFreshRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-cli-fresh-"));
  const configDir = path.join(root, "config");
  mkdirSync(configDir);
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    "data_dir: ../data\ndefault_agent: null\nclaude:\n  default_timeout_minutes: 0.05\n",
  );
  writeFileSync(path.join(configDir, "projects.yaml"), "projects: {}\n");
  return { root, configDir, project: realpathSync(project), agentsDir: path.join(root, "data", "agents") };
}

const QUICK_START_PROMPT =
  "You fix the failing test in this project. Run the tests, read the failure, change the minimum code, run them again. No git, no installs.";

test("README Quick start on a fresh clone: no agents, agents create fixer, then run --agent fixer completes", () => {
  const { root, configDir, project, agentsDir } = makeFreshRoot();
  const env = { CLAUDE_BIN: fakeBinary };
  try {
    const empty = cli(configDir, ["agents"], env);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), []);
    assert.match(empty.stderr, /Duskfleet ships none.*\n.*agents create <id>/);

    const doctor = cli(configDir, ["doctor"], env);
    assert.deepEqual(JSON.parse(doctor.stdout).agents, []);

    const noAgent = cli(configDir, ["run", "--project", project, "--", "Fix the failing test"], env);
    assert.notEqual(noAgent.status, 0);
    assert.match(
      noAgent.stderr,
      /Known agents: \(none: no agent file in .+ or .+; create one with "agents create <id>"\)/,
    );

    const created = cli(configDir, ["agents", "create", "fixer", "--model", "haiku", "--", QUICK_START_PROMPT], env);
    assert.equal(created.status, 0, created.stderr);
    const out = JSON.parse(created.stdout);
    assert.equal(out.created, true);
    assert.equal(out.agent.id, "fixer");
    assert.equal(out.agent.source, "user");
    assert.equal(out.agent.model, "haiku");
    assert.equal(out.agent.maxBudgetUsd, 0.5);
    assert.equal(out.agent.permissionMode, "dontAsk");
    assert.equal(out.agent.timeoutMinutes, 10);
    assert.ok(out.agent.allowedTools.includes("Bash(npm test:*)"));
    assert.ok(out.agent.allowedTools.includes("Edit"));
    assert.deepEqual(readdirSync(agentsDir), ["fixer.md"], "written to the user agents dir, never config/agents");
    assert.deepEqual(readdirSync(configDir).sort(), ["duskfleet.yaml", "projects.yaml"]);

    const listed = JSON.parse(cli(configDir, ["agents"], env).stdout);
    assert.deepEqual(
      listed.map((a) => a.id),
      ["fixer"],
    );

    const run = cli(configDir, ["run", "--project", project, "--agent", "fixer", "--", "Fix the failing test"], env);
    assert.equal(run.status, 0, run.stderr);
    const r = JSON.parse(run.stdout);
    assert.equal(r.status, "completed");
    assert.equal(r.agentId, "fixer");
    assert.equal(r.command.binary, fakeBinary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents create refuses an existing id without --force, home paths, secrets and empty prompts, leaving no file", () => {
  const { root, configDir, agentsDir } = makeFreshRoot();
  const env = { CLAUDE_BIN: fakeBinary };
  const files = () => {
    try {
      return readdirSync(agentsDir).sort();
    } catch {
      return [];
    }
  };
  try {
    const first = cli(configDir, ["agents", "create", "fixer", "--", "Be brief."], env);
    assert.equal(first.status, 0, first.stderr);

    const again = cli(configDir, ["agents", "create", "fixer", "--model", "sonnet", "--", "Be brief."], env);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /agent "fixer" already exists \(.+fixer\.md\)\. Pass --force to replace it\./);

    const forced = cli(
      configDir,
      ["agents", "create", "fixer", "--force", "--model", "sonnet", "--", "Be brief."],
      env,
    );
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(forced.stdout).agent.model, "sonnet");
    assert.equal(JSON.parse(forced.stdout).overrode, "user");

    const home = ["", "Users", "alice"].join("/");
    const homePath = cli(
      configDir,
      ["agents", "create", "leaky", "--description", `notes in ${home}/x`, "--", "Hi."],
      env,
    );
    assert.notEqual(homePath.status, 0);
    assert.match(homePath.stderr, /macOS home path/);

    const secret = cli(configDir, ["agents", "create", "secret", "--", `Use sk-ant-${"a".repeat(20)} for calls.`], env);
    assert.notEqual(secret.status, 0);
    assert.match(secret.stderr, /Anthropic API key/);

    const noPrompt = cli(configDir, ["agents", "create", "mute"], env);
    assert.notEqual(noPrompt.status, 0);
    assert.match(noPrompt.stderr, /needs a system prompt/);

    const badBudget = cli(configDir, ["agents", "create", "cheap", "--budget", "lots", "--", "Hi."], env);
    assert.notEqual(badBudget.status, 0);
    assert.match(badBudget.stderr, /--budget must be a number/);

    const bypass = cli(
      configDir,
      ["agents", "create", "wild", "--permission-mode", "bypassPermissions", "--", "Hi."],
      env,
    );
    assert.notEqual(bypass.status, 0);
    assert.match(bypass.stderr, /bypassPermissions cannot be set here/);

    const badId = cli(configDir, ["agents", "create", "Bad Id", "--", "Hi."], env);
    assert.notEqual(badId.status, 0);

    assert.deepEqual(files(), ["fixer.md"], "no file left behind by a refused create");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CLAUDE_BIN that does not exist falls through to claude.binary and never reaches the run's child", () => {
  const { root, configDir } = makeRoot();
  try {
    const res = cli(configDir, ["run", "--project", "demo", "--", "env"], {
      CLAUDE_BIN: path.join(root, "no-such-claude"),
    });
    assert.equal(res.status, 0, res.stderr);
    const run = JSON.parse(res.stdout);
    assert.equal(run.command.binary, fakeBinary);
    assert.equal(run.resultText, "CLAUDE_BIN unset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
