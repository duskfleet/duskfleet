/**
 * Default log level per entry point (#352): one-shot CLI commands show warnings and errors only,
 * `--verbose` brings info back, DUSKFLEET_LOG_LEVEL wins over both; `serve` and the MCP server
 * keep info. Migrations are one line, not one per migration.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const cliEntry = path.join(here, "..", "dist", "cli.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-log-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nclaude:\n  binary: ${JSON.stringify(fakeBinary)}\n`,
  );
  writeFileSync(path.join(configDir, "projects.yaml"), "projects: {}\n");
  return { root, configDir };
}

/** The test env without DUSKFLEET_LOG_LEVEL unless given: the entry point's default decides. */
function env(configDir, level) {
  const e = testEnv({ DUSKFLEET_CONFIG: configDir });
  delete e.DUSKFLEET_LOG_LEVEL;
  if (level) e.DUSKFLEET_LOG_LEVEL = level;
  return e;
}

function cli(configDir, args, level) {
  return spawnSync(process.execPath, [cliEntry, ...args], { env: env(configDir, level), encoding: "utf8" });
}

/** Starts a long-running entry, resolves with its stderr once `pattern` shows up, then stops it. */
function stderrUntil(entry, args, configDir, pattern) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: env(configDir), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no ${pattern} within 15 s; stderr:\n${stderr}`));
    }, 15_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (pattern.test(stderr)) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(stderr);
      }
    });
    child.on("error", reject);
  });
}

test("a one-shot CLI command prints no info lines by default; --verbose brings them back, migrations in one line", () => {
  const { root, configDir } = makeRoot();
  try {
    const quiet = cli(configDir, ["agents", "--json"]);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.deepEqual(JSON.parse(quiet.stdout), [], "with --json, stdout is only the JSON");
    assert.doesNotMatch(quiet.stderr, /\[info\]/, "no info lines, not even the migrations of a fresh database");

    rmSync(path.join(root, "data"), { recursive: true, force: true }); // fresh database again
    const verbose = cli(configDir, ["agents", "--verbose", "--json"]);
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.deepEqual(JSON.parse(verbose.stdout), [], "with --json, --verbose is not passed on to the command");
    assert.match(verbose.stderr, /\[info\] bootstrap: config loaded/);
    assert.match(verbose.stderr, /\[info\] storage: applied \d+ migrations \(0 → \d+\)/);
    assert.equal(verbose.stderr.match(/storage: applied/g)?.length, 1, "one line for the whole batch");
    assert.doesNotMatch(verbose.stderr, /applied migration \d/);

    const again = cli(configDir, ["agents", "--verbose"]);
    assert.doesNotMatch(again.stderr, /storage: applied/, "nothing to apply, nothing logged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DUSKFLEET_LOG_LEVEL wins over the CLI default and over --verbose", () => {
  const { root, configDir } = makeRoot();
  try {
    const info = cli(configDir, ["agents"], "info");
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stderr, /\[info\] bootstrap: config loaded/);

    const error = cli(configDir, ["agents", "--verbose"], "error");
    assert.equal(error.status, 0, error.stderr);
    assert.doesNotMatch(error.stderr, /\[info\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--verbose after -- is part of the prompt, not a flag", () => {
  const { root, configDir } = makeRoot();
  try {
    // `agents create` takes the system prompt after `--`: the flag there stays in the prompt.
    const r = cli(configDir, ["agents", "create", "quiet", "--model", "haiku", "--", "--verbose"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /\[info\]/, "a --verbose after -- does not raise the level");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serve keeps info by default", async () => {
  const { root, configDir } = makeRoot();
  try {
    const stderr = await stderrUntil(cliEntry, ["serve"], configDir, /\[info\] storage: applied \d+ migrations/);
    assert.match(stderr, /\[info\] bootstrap: config loaded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the MCP server keeps info by default", async () => {
  const { root, configDir } = makeRoot();
  try {
    const stderr = await stderrUntil(serverEntry, [], configDir, /\[info\] storage: applied \d+ migrations/);
    assert.match(stderr, /\[info\] bootstrap: config loaded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
