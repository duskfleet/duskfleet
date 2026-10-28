/** The environment allow-list for run children and command gates (child-env.ts). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { childEnv, envNameMatches, loadConfig, mergeEnvPassthrough, runCommandGate } from "@duskfleet/core";

const source = {
  PATH: "/home/me/.local/bin:/usr/bin:/bin",
  HOME: "/home/me",
  LANG: "en_GB.UTF-8",
  LC_ALL: "en_GB.UTF-8",
  ANTHROPIC_API_KEY: "sk-test",
  CLAUDE_CONFIG_DIR: "/home/me/.claude",
  NODE_OPTIONS: "--max-old-space-size=4096",
  npm_config_cache: "/tmp/npm",
  XDG_CONFIG_HOME: "/home/me/.config",
  GITHUB_TOKEN: "ghp_secret",
  AWS_SECRET_ACCESS_KEY: "aws",
  DF_TEST_SECRET: "1",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SSE_PORT: "1234",
  CLAUDE_BIN: "/somewhere/claude",
};

test("only the default allow-list reaches the child; nesting markers and CLAUDE_BIN never do", () => {
  const env = childEnv([], source, "linux");
  assert.deepEqual(Object.keys(env).sort(), [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_OPTIONS",
    "PATH",
    "XDG_CONFIG_HOME",
    "npm_config_cache",
  ]);
  assert.equal(source.GITHUB_TOKEN, "ghp_secret", "the source is not mutated");
});

test("env_passthrough adds exact names and PREFIX_* entries, never the always-dropped ones", () => {
  const env = childEnv(["DF_TEST_SECRET", "AWS_*", "CLAUDE_BIN", "CLAUDECODE"], source, "linux");
  assert.equal(env.DF_TEST_SECRET, "1");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "aws");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.CLAUDE_BIN, undefined, "CLAUDE_BIN would make an agent's npm test launch the real claude");
  assert.equal(env.CLAUDECODE, undefined);
});

test("names match case-insensitively on Windows only", () => {
  assert.equal(envNameMatches("Path", "PATH", "win32"), true);
  assert.equal(envNameMatches("SYSTEMROOT", "SystemRoot", "win32"), true);
  assert.equal(envNameMatches("Path", "PATH", "linux"), false);
  const env = childEnv([], { Path: "C:\\bin", SystemRoot: "C:\\Windows", Secret: "x" }, "win32");
  assert.deepEqual(env, { Path: "C:\\bin", SystemRoot: "C:\\Windows" });
});

test("a minimal macOS PATH still gets the install directories", () => {
  assert.equal(
    childEnv([], { PATH: "/usr/bin:/bin" }, "darwin").PATH,
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  );
});

test("mergeEnvPassthrough merges global and agent lists without duplicates", () => {
  assert.deepEqual(mergeEnvPassthrough(["GH_TOKEN"], undefined, ["GH_TOKEN", "AWS_*"]), ["GH_TOKEN", "AWS_*"]);
  assert.deepEqual(mergeEnvPassthrough(undefined, undefined), []);
});

test("a command gate gets the allow-list, plus its passthrough", { skip: process.platform === "win32" }, async () => {
  process.env.DF_TEST_SECRET = "1";
  try {
    const hidden = await runCommandGate('printf %s "${DF_TEST_SECRET:-unset}"', tmpdir(), 10);
    assert.equal(hidden.kind, "run");
    assert.equal(hidden.reason, "unset");
    const passed = await runCommandGate('printf %s "${DF_TEST_SECRET:-unset}"', tmpdir(), 10, ["DF_TEST_SECRET"]);
    assert.equal(passed.reason, "1");
  } finally {
    delete process.env.DF_TEST_SECRET;
  }
});

test("claude.env_passthrough and an agent's env_passthrough load; a bad entry is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-env-"));
  try {
    const configDir = path.join(root, "config");
    mkdirSync(path.join(configDir, "agents"), { recursive: true });
    writeFileSync(
      path.join(configDir, "duskfleet.yaml"),
      'data_dir: ../data\nclaude:\n  env_passthrough: ["GH_TOKEN", "AWS_*"]\n',
    );
    writeFileSync(path.join(configDir, "agents", "gh.md"), '---\nenv_passthrough: ["NPM_TOKEN"]\n---\nUses gh.\n');
    const config = loadConfig(configDir);
    assert.deepEqual(config.claude.envPassthrough, ["GH_TOKEN", "AWS_*"]);
    assert.deepEqual(config.agents.get("gh").envPassthrough, ["NPM_TOKEN"]);

    writeFileSync(path.join(configDir, "agents", "gh.md"), '---\nenv_passthrough: ["NOT A NAME"]\n---\nBad.\n');
    assert.throws(() => loadConfig(configDir), /env_passthrough/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without env_passthrough the global list is empty", () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-env-"));
  try {
    const configDir = path.join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\n");
    assert.deepEqual(loadConfig(configDir).claude.envPassthrough, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
