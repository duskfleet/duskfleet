/**
 * CLI: `run --project` accepts a registered project id as well as an absolute path.
 * The id-vs-path decision is core's (RunManager.resolveProject), so MCP's project_path behaves the same.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
