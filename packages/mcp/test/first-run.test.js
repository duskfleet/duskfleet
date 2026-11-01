/**
 * The guided first run (#204): `run --first` is the same code as the last step of an interactive
 * `init`. Answers go in on stdin (a pipe); fake-claude.js plays the run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@duskfleet/core";
import { FIRST_RUN_PROMPT, firstRunAgentProblems } from "../dist/first-run.js";
import { offersFirstRun } from "../dist/init.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const cliEntry = path.join(here, "..", "dist", "cli.js");

/** A fresh setup: no agent, no project, claude found through CLAUDE_BIN. */
function makeRoot(extraYaml = "") {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-first-run-"));
  const configDir = path.join(root, "config");
  mkdirSync(configDir);
  const project = path.join(root, "my-app");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: null\nclaude:\n  default_timeout_minutes: 0.05\n${extraYaml}`,
  );
  writeFileSync(path.join(configDir, "projects.yaml"), "projects: {}\n");
  const agentFile = path.join(root, "data", "agents", "first-run.md");
  return { root, configDir, project: realpathSync(project), agentFile };
}

function cli(configDir, args, input = "") {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn", CLAUDE_BIN: fakeBinary }),
    encoding: "utf8",
    input,
  });
}

test("run --first end to end: registers the project, creates the agent, runs haiku, prints the summary, deletes on n", () => {
  const { root, configDir, project, agentFile } = makeRoot();
  try {
    // Path from stdin, then "n" to "Keep the first-run agent?".
    const res = cli(configDir, ["run", "--first"], `${project}\nn\n`);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /read-only "first-run" agent, runs it with haiku and costs cents/);
    assert.match(res.stdout, /Project "my-app" registered in .+projects\.yaml/);
    assert.match(res.stdout, /Agent "first-run" written to .+first-run\.md/);
    assert.match(res.stdout, /Run \S+: completed/);
    assert.match(res.stdout, /duration \d+\.\d s, \d+ tokens \(\d+ in, \d+ out\), (API value|Cost) \$0\.0123/);
    assert.match(res.stdout, /The agent said:/);
    assert.match(res.stdout, /duskfleet run-info \S+/);
    assert.match(res.stdout, /duskfleet dashboard/);
    assert.match(res.stdout, /Deleted .+first-run\.md \(the run keeps its agent id\)/);
    assert.equal(existsSync(agentFile), false, "the agent was deleted on n");

    const config = loadConfig(configDir);
    assert.equal(config.projects.get("my-app")?.path, project, "registered in the private registry");
    assert.ok(readFileSync(config.userProjectsFile, "utf8").includes("my-app"));

    const runs = JSON.parse(cli(configDir, ["runs"]).stdout);
    assert.equal(runs.length, 1);
    const info = JSON.parse(cli(configDir, ["run-info", runs[0].id]).stdout);
    assert.equal(info.agentId, "first-run", "the run row keeps its agent id after the delete");
    assert.equal(info.modelRequested, "haiku");
    assert.equal(info.projectId, "my-app");
    assert.equal(info.prompt, FIRST_RUN_PROMPT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run --first twice: the agent is kept by default and reused on the second pass", () => {
  const { root, configDir, project, agentFile } = makeRoot();
  try {
    const first = cli(configDir, ["run", "--first", "--project", project], "\n");
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /Kept: .+first-run\.md/);
    assert.ok(existsSync(agentFile));
    const agent = loadConfig(configDir).agents.get("first-run");
    assert.equal(agent.model, "haiku");
    assert.equal(agent.permissionMode, "dontAsk");
    assert.deepEqual(agent.disallowedTools, ["Edit", "Write", "NotebookEdit"]);

    // No answer at all (end of input): the default keeps the agent again.
    const second = cli(configDir, ["run", "--first", "--project", project]);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /Agent "first-run" already exists \(.+\); using it\./);
    assert.doesNotMatch(second.stdout, /registered in/, "the project is registered once");
    assert.match(second.stdout, /Run \S+: completed/);
    assert.doesNotMatch(
      second.stdout,
      /Keep the first-run agent/,
      "a pre-existing agent is never offered for deletion",
    );
    assert.ok(existsSync(agentFile));

    // Even an explicit "n" cannot delete a file this pass did not write.
    const third = cli(configDir, ["run", "--first", "--project", project], "n\n");
    assert.equal(third.status, 0, third.stderr + third.stdout);
    assert.ok(existsSync(agentFile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run --first refuses an existing first-run agent that is not read-only and cheap, before registering anything", () => {
  const { root, configDir, project, agentFile } = makeRoot();
  try {
    mkdirSync(path.dirname(agentFile), { recursive: true });
    writeFileSync(
      agentFile,
      "---\ndescription: mine\nmodel: haiku\npermission_mode: acceptEdits\nallowed_tools: [Read, Bash]\nmax_budget_usd: 5\n---\nI edit things.\n",
    );
    assert.ok(loadConfig(configDir).agents.has("first-run"), "the fixture agent loads");
    const res = cli(configDir, ["run", "--first", "--project", project], "n\n");
    assert.equal(res.status, 1, res.stderr + res.stdout);
    assert.match(res.stderr, /existing "first-run" agent .+ is not the read-only, cheap agent/);
    assert.match(res.stderr, /permission_mode is acceptEdits/);
    assert.match(res.stderr, /disallowed_tools lacks Edit, Write, NotebookEdit/);
    assert.match(res.stderr, /allowed_tools contains Bash/);
    assert.match(res.stderr, /max_budget_usd is \$5, above \$0\.25/);
    assert.equal(loadConfig(configDir).projects.size, 0, "nothing registered");
    assert.equal(JSON.parse(cli(configDir, ["runs"]).stdout).length, 0, "nothing run");
    assert.ok(existsSync(agentFile), "the user's agent is left alone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("firstRunAgentProblems: the step's own agent passes, a project binding elsewhere does not", () => {
  const { root, configDir, project } = makeRoot();
  try {
    const config = loadConfig(configDir);
    const agent = {
      id: "first-run",
      source: "user",
      name: "first-run",
      description: "",
      model: "haiku",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Grep", "Glob"],
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      maxBudgetUsd: 0.25,
      systemPrompt: "",
      sourcePath: "x",
    };
    assert.deepEqual(firstRunAgentProblems(agent, project, config), []);
    assert.deepEqual(firstRunAgentProblems({ ...agent, project: "other" }, project, config), [
      'it is bound to project "other"',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run --first refuses a path outside allowed_project_roots with the config hint, creating nothing", () => {
  const allowed = mkdtempSync(path.join(tmpdir(), "duskfleet-allowed-"));
  const { root, configDir, project, agentFile } = makeRoot(`allowed_project_roots: [${JSON.stringify(allowed)}]\n`);
  try {
    const res = cli(configDir, ["run", "--first", "--project", project]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /outside allowed_project_roots/);
    assert.match(
      res.stderr,
      /add its parent to allowed_project_roots in .+duskfleet\.yaml \(docs\/configuration\.md\)/,
    );
    assert.equal(existsSync(agentFile), false);
    assert.equal(loadConfig(configDir).projects.size, 0);

    const extra = cli(configDir, ["run", "--first", "--agent", "x"]);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /run --first takes only --project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(allowed, { recursive: true, force: true });
  }
});

test("init offers the first run only on a terminal and never under --yes", () => {
  assert.equal(offersFirstRun(true, true), false);
  assert.equal(offersFirstRun(true, false), false);
  assert.equal(offersFirstRun(false, false), false);
  assert.equal(offersFirstRun(false, true), true);
});
