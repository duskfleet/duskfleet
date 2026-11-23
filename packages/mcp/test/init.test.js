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

/**
 * Leaves only the named CLIs findable: the others point at a missing file (an override that does
 * not exist finds nothing), and PATH holds only `node`, so no real `claude` on the machine is found.
 */
function only(s, ...present) {
  const missing = path.join(s.root, "no-such-binary");
  if (!present.includes("claude")) {
    s.env.CLAUDE_BIN = missing;
    const bin = path.join(s.root, "bin");
    mkdirSync(bin, { recursive: true });
    if (!existsSync(path.join(bin, "node"))) symlinkSync(process.execPath, path.join(bin, "node"));
    s.env.PATH = bin;
  }
  if (!present.includes("copilot")) s.env.COPILOT_BIN = missing;
  if (!present.includes("codex")) s.env.CODEX_BIN = missing;
}

test("init with only Claude Code (#489): usable, the other two named as optional, exit 0", () => {
  const s = sandbox();
  try {
    only(s, "claude");
    const init = s.cli("init", "--yes");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /\[2\/5\] Agent CLIs: Claude Code usable/);
    assert.match(init.stdout, /^ {6}GitHub Copilot CLI: not found \(optional; harness: copilot\)$/m);
    assert.match(init.stdout, /^ {6}Codex CLI: not found \(optional; harness: codex\)$/m);
    assert.match(
      init.stdout,
      /Optional, not installed: GitHub Copilot CLI \(harness: copilot\), Codex CLI \(harness: codex\)\. One agent CLI is enough/,
    );
    assert.doesNotMatch(init.stdout + init.stderr, /none usable|Until then/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init with only Codex CLI (#489): usable and logged in, nothing reported broken, next commands on codex", () => {
  const s = sandbox();
  try {
    only(s, "codex");
    const init = s.cli("init", "--yes");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /\[2\/5\] Agent CLIs: Codex CLI usable/);
    assert.match(init.stdout, /^ {6}Claude Code: not found \(optional; harness: claude\)$/m);
    assert.match(init.stdout, /^ {6}Codex CLI codex-cli 0\.167\.1 \(.+\): logged in \(ChatGPT\)$/m);
    assert.equal(init.stderr, "", "nothing on stderr: no problem to report");
    assert.doesNotMatch(init.stdout, /none usable|not installed: install|Until then|not logged in/);
    assert.match(init.stdout, /agents create fixer --harness codex -- /);

    // The next command of the summary works as printed (no extra flag) and the agent runs on the fake CLI.
    const create = s.cli("agents", "create", "fixer", "--harness", "codex", "--", "You fix failing tests.");
    assert.equal(create.status, 0, create.stderr);
    const project = path.join(s.root, "project");
    mkdirSync(project);
    const run = s.cli("run", "--project", project, "--agent", "fixer", "--json", "--", "Make the tests pass");
    assert.equal(run.status, 0, run.stderr);
    const recorded = JSON.parse(run.stdout);
    assert.equal(recorded.status, "completed");
    assert.equal(recorded.harness, "codex");

    // doctor: Claude Code is optional here, not a red "not found", and not in the exit code.
    const doctor = s.cli("doctor");
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /claude +not installed \(optional: another agent CLI is registered\)/);
    assert.doesNotMatch(doctor.stdout, /claude +not found/);
    const doctorJson = JSON.parse(s.cli("doctor", "--json").stdout);
    assert.equal(doctorJson.error, null);
    assert.match(doctorJson.claudeOptional, /./);

    // Registering in Claude Code needs its CLI: refused before any plan, Claude Desktop suggested.
    for (const args of [
      ["mcp", "register", "--target", "claude-code", "--yes"],
      ["init", "--mcp", "claude-code", "--yes"],
    ]) {
      const register = s.cli(...args);
      assert.doesNotMatch(register.stdout, /will run:/, args.join(" "));
      assert.match(
        register.stderr,
        /Registering in Claude Code needs the Claude Code CLI.*\n.*--target claude-desktop/,
      );
      assert.doesNotMatch(register.stderr, /ENOENT/);
    }
    assert.equal(s.cli("mcp", "register", "--target", "claude-code", "--yes").status, 1);

    // init does not abort on it: the summary printed, the failure repeated after it, then exit 1.
    const initMcp = s.cli("init", "--mcp", "claude-code", "--yes");
    assert.equal(initMcp.status, 1, initMcp.stderr);
    assert.match(initMcp.stdout, /\[5\/5\] Done\./);
    assert.match(initMcp.stdout, /agents create fixer --harness codex -- /);
    assert.match(
      initMcp.stderr,
      /\n\nMCP registration failed \(exit 1\); run it again with: duskfleet mcp register --target claude-code\n?$/,
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init with no agent CLI (#489): none usable, how to get one, exit 0 and the config written", () => {
  const s = sandbox();
  try {
    only(s);
    const init = s.cli("init", "--yes");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stderr, /\[2\/5\] Agent CLIs: none usable/);
    for (const label of ["Claude Code", "GitHub Copilot CLI", "Codex CLI"]) {
      assert.match(init.stdout, new RegExp(`^ {6}${label}: not found \\(optional`, "m"));
    }
    assert.match(
      init.stdout,
      /No agent CLI is installed: install one of Claude Code, GitHub Copilot CLI, Codex CLI \(any one is enough/,
    );
    assert.match(
      init.stdout,
      /Until then the config, mcp register --target claude-desktop and the dashboard work; every other command \(doctor, agents, projects, schedules, budgets, run, serve\) needs an agent CLI installed\./,
    );
    assert.ok(existsSync(s.yaml));

    // The advice is what happens: a command that bootstraps refuses with the lookup error.
    for (const args of [["agents"], ["agents", "create", "fixer", "--", "You fix failing tests."], ["projects"]]) {
      const r = s.cli(...args);
      assert.notEqual(r.status, 0, `${args.join(" ")} works without an agent CLI: fix the advice`);
    }

    // --mcp claude-desktop with no agent CLI at all (#490): Desktop needs none, so it registers,
    // init reaches the summary and the install advice, and exits 0.
    const desktop = desktopConfigPath(process.platform, s.home, s.env);
    const initMcp = s.cli("init", "--yes", "--mcp", "claude-desktop");
    assert.equal(initMcp.status, 0, initMcp.stderr);
    assert.match(initMcp.stdout, /\[4\/5\] MCP registration: claude-desktop/);
    assert.match(initMcp.stdout, /\[5\/5\] Done\./);
    assert.match(initMcp.stdout, /No agent CLI is installed: install one of/);
    assert.doesNotMatch(initMcp.stderr, /MCP registration failed|UnhandledPromiseRejection|^\s+at /m);
    assert.ok(JSON.parse(readFileSync(desktop, "utf8")).mcpServers?.duskfleet, "the desktop entry is written");
    // Same for mcp register itself; claude-code still refuses (it runs claude mcp add).
    assert.equal(s.cli("mcp", "register", "--target", "claude-desktop", "--yes").status, 0);
    const code = s.cli("mcp", "register", "--target", "claude-code", "--yes");
    assert.equal(code.status, 1);
    assert.match(code.stderr, /Registering in Claude Code needs the Claude Code CLI/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init --harness: an unknown name is a usage error (exit 2)", () => {
  const s = sandbox();
  try {
    const bad = s.cli("init", "--yes", "--harness", "cursor");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--harness must be one of claude, copilot, codex, got "cursor"/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init --harness (#490): the agents create hint names that CLI when usable, else a usable one", () => {
  const s = sandbox();
  try {
    // All three usable: --harness codex wins over Claude Code, the default.
    const codex = s.cli("init", "--yes", "--harness", "codex");
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(codex.stdout, /agents create fixer --harness codex -- /);
    const copilot = s.cli("init", "--yes", "--harness", "copilot");
    assert.match(copilot.stdout, /agents create fixer --harness copilot -- /);
    // --harness claude is the default harness: the worked example, no flag.
    const claude = s.cli("init", "--yes", "--harness", "claude");
    assert.match(claude.stdout, /agents create fixer --model haiku/);

    // Only Codex usable: an unusable --harness falls back to a usable CLI, never names a missing one.
    only(s, "codex");
    const fallback = s.cli("init", "--yes", "--harness", "copilot");
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /agents create fixer --harness codex -- /);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("init --yes from an empty directory: starter config, exit 0, doctor works, no agent shipped", () => {
  const s = sandbox();
  try {
    const init = s.cli("init", "--yes");
    assert.equal(init.status, 0, init.stderr);
    // All three CLIs found (fake-claude, and COPILOT_BIN / CODEX_BIN from helpers.js): three lines.
    assert.match(init.stdout, /\[2\/5\] Agent CLIs: Claude Code, GitHub Copilot CLI, Codex CLI usable/);
    assert.match(init.stdout, /^ {6}Claude Code 9\.9\.9 \(fake\) \(.+\): logged in \(claude\.ai\)$/m);
    assert.match(init.stdout, /^ {6}GitHub Copilot CLI 1\.0\.112\. \(.+\): login not checked/m);
    assert.match(init.stdout, /^ {6}Codex CLI codex-cli 0\.167\.1 \(.+\): logged in \(ChatGPT\)$/m);
    assert.doesNotMatch(init.stdout, /Optional, not installed|Until then/);
    assert.match(init.stdout, /agents create fixer --model haiku/, "Claude Code stays the worked example");
    assert.match(init.stdout, /\[3\/5\] Config: created .*duskfleet\.yaml/);
    assert.match(init.stdout, /\[4\/5\] MCP registration: skipped/);
    assert.match(init.stdout, /duskfleet agents create/);
    assert.doesNotMatch(init.stdout + init.stderr, /first run/i, "init --yes never reaches the guided first run");
    assert.ok(existsSync(s.yaml));

    const doctor = s.cli("doctor", "--json");
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

test("init with Claude Code logged out (#349): config written, login hint, exit 0; read-only commands work, run is auth_required", () => {
  const s = sandbox();
  try {
    // A logged-out claude: `auth status --json` says loggedIn false and exits 1; a run gets the
    // logged-out result of fake-claude.js (FAKE_CLAUDE_MODE=auth, set here, past the env allow-list).
    const loggedOut = path.join(s.root, "claude-logged-out.js");
    writeFileSync(
      loggedOut,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const a = process.argv.slice(2);",
        'if (a[0] === "--version") { process.stdout.write("9.9.9 (fake)\\n"); process.exit(0); }',
        'if (a[0] === "auth" && a[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n"); process.exit(1); }',
        `const r = spawnSync(process.execPath, [${JSON.stringify(fakeBinary)}, ...a], { stdio: "inherit", env: { ...process.env, FAKE_CLAUDE_MODE: "auth" } });`,
        "process.exit(r.status ?? 1);",
        "",
      ].join("\n"),
    );
    chmodSync(loggedOut, 0o755);
    s.env.CLAUDE_BIN = loggedOut;

    for (const args of [["init", "--yes"], ["init"]]) {
      const init = s.cli(...args);
      assert.equal(init.status, 0, `${args.join(" ")}: ${init.stderr}`);
      assert.match(init.stderr, /^ {6}Claude Code 9\.9\.9 \(fake\) \(.+\): not logged in$/m);
      assert.match(init.stdout, /\[3\/5\] Config: (created|.*already exists)/);
      assert.match(
        init.stdout,
        /Claude Code is not logged in: run claude auth login, then check it with: duskfleet doctor --probe/,
      );
      assert.ok(existsSync(s.yaml), "the config is written without a login");
    }

    const doctor = s.cli("doctor", "--json");
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).configSource, "user");
    for (const args of [["agents"], ["projects"], ["runs"], ["schedules"]]) {
      const r = s.cli(...args);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    }
    const create = s.cli("agents", "create", "fixer", "--model", "haiku", "--", "You fix failing tests.");
    assert.equal(create.status, 0, create.stderr);

    const project = path.join(s.root, "project");
    mkdirSync(project);
    const run = s.cli("run", "--project", project, "--agent", "fixer", "--json", "--", "Make the tests pass");
    assert.equal(run.status, 1, run.stderr);
    const recorded = JSON.parse(run.stdout);
    assert.equal(recorded.status, "failed");
    assert.equal(recorded.errorCode, "auth_required");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
