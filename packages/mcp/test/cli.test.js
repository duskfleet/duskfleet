/**
 * CLI: `run --project` accepts a registered project id as well as an absolute path.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const cliEntry = path.join(here, "..", "dist", "cli.js");

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-cli-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(path.join(configDir, "duskfleet.yaml"), `data_dir: ../data\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`);
  writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  demo:\n    path: ${realpathSync(project)}\n`); // resolved: core matches path-launched runs to projects by exact path
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  return { root, configDir, project: realpathSync(project) };
}

function cli(configDir, args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    env: { ...process.env, DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" },
    encoding: "utf8",
  });
}

test("cli run --project accepts a registered id, a path, and rejects anything else", () => {
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
    assert.match(unknown.stderr, /project path must be absolute: nope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
