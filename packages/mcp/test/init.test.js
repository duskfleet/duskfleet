/**
 * `duskfleet init` (#203): the built package outside any checkout, a fake home (HOME and XDG
 * variables in a temp dir) and fake-claude.js. Nothing of the real user is read or written.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { desktopConfigPath } from "../dist/mcp-register.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const bundleDir = path.join(here, "..", "..", "duskfleet", "dist");
const repoNodeModules = path.join(here, "..", "..", "..", "node_modules");

/** A copy of the published package with no repository above it, a fake home and an empty cwd. */
function sandbox() {
  assert.ok(existsSync(path.join(bundleDir, "cli.js")), "packages/duskfleet/dist is missing: run npm run build");
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-init-"));
  const pkg = path.join(root, "pkg");
  cpSync(path.join(bundleDir, ".."), pkg, { recursive: true, filter: (src) => !src.includes("node_modules") });
  symlinkSync(repoNodeModules, path.join(pkg, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const home = path.join(root, "home");
  mkdirSync(home);
  const cwd = path.join(root, "empty");
  mkdirSync(cwd);
  const xdgConfig = path.join(home, "xdg-config");
  const env = testEnv({
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    CLAUDE_BIN: fakeBinary,
    DUSKFLEET_LOG_LEVEL: "warn",
  });
  delete env.DUSKFLEET_CONFIG;
  const cli = (...args) =>
    spawnSync(process.execPath, [path.join(pkg, "dist", "cli.js"), ...args], { cwd, env, encoding: "utf8" });
  const yaml = path.join(xdgConfig, "duskfleet", "duskfleet.yaml");
  return { root, home, env, cli, yaml };
}

test("init --yes from an empty directory: starter config, exit 0, doctor works, no agent shipped", () => {
  const s = sandbox();
  try {
    const init = s.cli("init", "--yes");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /\[2\/5\] Claude Code 9\.9\.9 \(fake\).*logged in/);
    assert.match(init.stdout, /\[3\/5\] Config: created .*duskfleet\.yaml/);
    assert.match(init.stdout, /\[4\/5\] MCP registration: skipped/);
    assert.match(init.stdout, /duskfleet agents create/);
    assert.ok(existsSync(s.yaml));

    const doctor = s.cli("doctor");
    assert.equal(doctor.status, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.configSource, "user");
    assert.deepEqual(report.agents, [], "Duskfleet ships no agent");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init twice: the second run reports the existing config and changes nothing", () => {
  const s = sandbox();
  try {
    assert.equal(s.cli("init", "--yes").status, 0);
    writeFileSync(s.yaml, "max_concurrent_runs: 3\n");
    const before = statSync(s.yaml).mtimeMs;
    const again = s.cli("init", "--yes");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already exists \(user\); left as it is/);
    assert.match(again.stdout, /Nothing was created/);
    assert.equal(readFileSync(s.yaml, "utf8"), "max_concurrent_runs: 3\n");
    assert.equal(statSync(s.yaml).mtimeMs, before);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init --yes never writes a Claude config file unless --mcp is given", () => {
  const s = sandbox();
  try {
    const desktop = desktopConfigPath(process.platform, s.home, s.env);
    assert.ok(desktop.startsWith(s.root), desktop);
    const init = s.cli("init", "--yes");
    assert.equal(init.status, 0, init.stderr);
    assert.equal(existsSync(path.join(s.home, ".claude.json")), false);
    assert.equal(existsSync(desktop), false);

    const withMcp = s.cli("init", "--yes", "--mcp", "claude-desktop");
    assert.equal(withMcp.status, 0, withMcp.stderr);
    assert.match(withMcp.stdout, /\[4\/5\] MCP registration: claude-desktop/);
    const written = JSON.parse(readFileSync(desktop, "utf8"));
    assert.ok(written.mcpServers?.duskfleet, "the desktop entry is written with --mcp");

    const bad = s.cli("init", "--yes", "--mcp", "vscode");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--mcp must be claude-code or claude-desktop/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init with Claude Code logged out stops at step 2 with the login hint, exit 1, nothing written", () => {
  const s = sandbox();
  try {
    // `claude auth status --json` of a logged-out user: loggedIn false, exit 1.
    const loggedOut = path.join(s.root, "claude-logged-out.js");
    writeFileSync(
      loggedOut,
      [
        "#!/usr/bin/env node",
        "const a = process.argv.slice(2);",
        'if (a[0] === "--version") { process.stdout.write("9.9.9 (fake)\\n"); process.exit(0); }',
        'if (a[0] === "auth" && a[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n"); process.exit(1); }',
        "process.exit(3);",
        "",
      ].join("\n"),
    );
    chmodSync(loggedOut, 0o755);
    s.env.CLAUDE_BIN = loggedOut;
    const init = s.cli("init", "--yes");
    assert.equal(init.status, 1);
    assert.match(init.stderr, /\[2\/5\] Claude Code 9\.9\.9 \(fake\).*not logged in/);
    assert.match(init.stderr, /claude auth login/);
    assert.equal(existsSync(s.yaml), false, "init stopped before writing the config");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
