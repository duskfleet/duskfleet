/**
 * `duskfleet mcp register` / `mcp status`: the Claude Desktop entry is previewed as a diff, a
 * dry run touches nothing, a real write backs the file up first, a malformed file is refused,
 * the Claude Code command is printed before it runs. Every config lives under a temp HOME;
 * nothing is registered on the test machine and no real claude is started.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyDesktop,
  backupPath,
  claudeCodeAddArgs,
  desktopConfigPath,
  lineDiff,
  mcpStatus,
  planClaudeCode,
  planDesktop,
  serverEntry,
  writeAtomically,
} from "../dist/mcp-register.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const cliEntry = path.join(here, "..", "dist", "cli.js");

const entry = {
  command: "/opt/node/bin/node",
  args: ["/opt/duskfleet/dist/index.js"],
  env: { CLAUDE_BIN: "/opt/claude" },
};

function tempDir(prefix) {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

test("desktop config path per platform", () => {
  assert.equal(
    desktopConfigPath("darwin", "/home/me", {}),
    "/home/me/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(desktopConfigPath("linux", "/home/me", {}), "/home/me/.config/Claude/claude_desktop_config.json");
  assert.equal(
    desktopConfigPath("linux", "/home/me", { XDG_CONFIG_HOME: "/xdg" }),
    "/xdg/Claude/claude_desktop_config.json",
  );
  assert.equal(
    desktopConfigPath("win32", "C:\\Users\\me", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }),
    "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
});

test("server entry: absolute node + index.js; npx pinned form only from npx's cache", () => {
  const input = {
    nodeBin: "/opt/node/bin/node",
    serverEntry: "/opt/duskfleet/dist/index.js",
    claudeBin: "/opt/claude",
    configDir: null,
    version: "1.2.3",
  };
  const plain = serverEntry(input);
  assert.equal(plain.form, "path");
  assert.deepEqual(plain.entry, entry);

  const npx = serverEntry({
    ...input,
    serverEntry: "/home/me/.npm/_npx/abc/node_modules/duskfleet/dist/index.js",
    configDir: "/home/me/df/config",
  });
  assert.equal(npx.form, "npx");
  assert.equal(npx.entry.command, "/opt/node/bin/npx");
  assert.deepEqual(npx.entry.args, ["-y", "-p", "duskfleet@1.2.3", "duskfleet-mcp"]);
  assert.equal(npx.entry.env.DUSKFLEET_CONFIG, "/home/me/df/config");
  assert.equal(npx.entry.env.DUSKFLEET_DATA, undefined);

  // a data dir the host would not resolve by itself (DUSKFLEET_DATA, XDG_DATA_HOME) is carried
  const withData = serverEntry({ ...input, dataDir: "/xdg/data/duskfleet" });
  assert.equal(withData.entry.env.DUSKFLEET_DATA, "/xdg/data/duskfleet");
});

test("line diff keeps common lines and marks the changed ones", () => {
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c"]), [" a", "-b", "+x", " c"]);
  assert.deepEqual(lineDiff([], ["a"]), ["+a"]);
});

test("planDesktop: new file, other servers kept, unchanged entry, malformed file refused", () => {
  const dir = tempDir("duskfleet-reg-");
  try {
    const file = path.join(dir, "Claude", "claude_desktop_config.json");
    const fresh = planDesktop(file, entry);
    assert.equal(fresh.exists, false);
    assert.equal(fresh.changed, true);
    assert.match(fresh.diff, /\+"duskfleet": \{/);
    assert.match(fresh.diff, /\+ {4}"\/opt\/duskfleet\/dist\/index\.js"/);

    mkdirSync(path.dirname(file));
    writeFileSync(file, JSON.stringify({ globalShortcut: "x", mcpServers: { other: { command: "o" } } }));
    const plan = planDesktop(file, entry);
    const written = JSON.parse(plan.content);
    assert.equal(written.globalShortcut, "x");
    assert.deepEqual(written.mcpServers.other, { command: "o" });
    assert.deepEqual(written.mcpServers.duskfleet, entry);

    writeFileSync(file, plan.content);
    assert.equal(planDesktop(file, entry).changed, false);
    const replaced = planDesktop(file, { ...entry, args: ["/new/index.js"] });
    assert.match(replaced.diff, /-\s+"\/opt\/duskfleet\/dist\/index\.js"/);
    assert.match(replaced.diff, /\+\s+"\/new\/index\.js"/);

    writeFileSync(file, "{ not json");
    assert.throws(() => planDesktop(file, entry), /not valid JSON.*nothing was changed/);
    writeFileSync(file, "[]");
    assert.throws(() => planDesktop(file, entry), /does not hold a JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDesktop: backup first, then the write; no backup for a new file; refuses a file broken since the preview", () => {
  const dir = tempDir("duskfleet-reg-");
  try {
    const file = path.join(dir, "claude_desktop_config.json");
    const original = '{"mcpServers":{}}';
    writeFileSync(file, original);
    const now = new Date("2026-10-26T10:00:00.000Z");
    const r = applyDesktop(planDesktop(file, entry), now);
    assert.equal(r.written, true);
    assert.equal(r.backup, backupPath(file, now));
    assert.match(r.backup, /claude_desktop_config\.json\.bak-2026-10-26T10-00-00-000Z$/);
    assert.equal(readFileSync(r.backup, "utf8"), original);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers.duskfleet, entry);

    const newFile = path.join(dir, "sub", "claude_desktop_config.json");
    const created = applyDesktop(planDesktop(newFile, entry));
    assert.deepEqual(created, { written: true, backup: null });

    const plan = planDesktop(file, { ...entry, args: ["/other"] });
    writeFileSync(file, "{ broken");
    assert.throws(() => applyDesktop(plan), /not valid JSON/);
    assert.equal(readFileSync(file, "utf8"), "{ broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDesktop: an edit made to the file while the prompt was open is kept", () => {
  const dir = tempDir("duskfleet-reg-");
  try {
    const file = path.join(dir, "claude_desktop_config.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "o" } } }));
    const plan = planDesktop(file, entry);
    const edited = JSON.stringify({
      globalShortcut: "y",
      mcpServers: { other: { command: "o" }, added: { command: "a" } },
    });
    writeFileSync(file, edited);
    const r = applyDesktop(plan);
    assert.equal(r.written, true);
    assert.equal(readFileSync(r.backup, "utf8"), edited);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.globalShortcut, "y");
    assert.deepEqual(written.mcpServers.added, { command: "a" });
    assert.deepEqual(written.mcpServers.other, { command: "o" });
    assert.deepEqual(written.mcpServers.duskfleet, entry);

    // Someone registered the same entry meanwhile: nothing left to write.
    const again = planDesktop(file, { ...entry, args: ["/other"] });
    writeFileSync(file, JSON.stringify({ mcpServers: { duskfleet: { ...entry, args: ["/other"] } } }));
    assert.deepEqual(applyDesktop(again), { written: false, backup: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDesktop keeps the file mode and a symlinked config; the tmp file never outlives a failed write", () => {
  const dir = tempDir("duskfleet-reg-");
  try {
    const real = path.join(dir, "dotfiles", "claude_desktop_config.json");
    mkdirSync(path.dirname(real));
    writeFileSync(real, JSON.stringify({ mcpServers: { other: { command: "o", env: { TOKEN: "t" } } } }));
    if (process.platform !== "win32") chmodSync(real, 0o600);
    const link = path.join(dir, "claude_desktop_config.json");
    symlinkSync(real, link);

    const r = applyDesktop(planDesktop(link, entry));
    assert.equal(r.written, true);
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is kept");
    assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).mcpServers.duskfleet, entry, "the target is written");
    if (process.platform !== "win32") assert.equal(statSync(real).mode & 0o777, 0o600, "mode kept");
    assert.deepEqual(readdirSync(path.dirname(real)), ["claude_desktop_config.json"], "no tmp file left");

    // A rename that fails (a directory in the way) leaves no tmp file behind.
    const blocked = path.join(dir, "blocked");
    mkdirSync(blocked);
    assert.throws(() => writeAtomically(blocked, "{}"));
    assert.equal(existsSync(`${blocked}.duskfleet-tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude mcp add: name first (before the variadic -e), user scope, env flags, then the command; status and conflicts from ~/.claude.json", () => {
  assert.deepEqual(claudeCodeAddArgs(entry), [
    "mcp",
    "add",
    "duskfleet",
    "--scope",
    "user",
    "-e",
    "CLAUDE_BIN=/opt/claude",
    "--",
    "/opt/node/bin/node",
    "/opt/duskfleet/dist/index.js",
  ]);
  const home = tempDir("duskfleet-home-");
  try {
    const fresh = planClaudeCode(entry, home);
    assert.equal(fresh.upToDate, false);
    assert.equal(fresh.conflict, null);
    assert.match(fresh.display, /^claude mcp add duskfleet --scope user -e CLAUDE_BIN=\/opt\/claude -- /);

    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { duskfleet: { type: "stdio", ...entry } } }),
    );
    assert.equal(planClaudeCode(entry, home).upToDate, true);
    const conflict = planClaudeCode({ ...entry, args: ["/elsewhere"] }, home);
    assert.equal(conflict.conflict?.command, entry.command);
    // Same command and args, but a stale or missing CLAUDE_BIN: a conflict, never "up to date".
    const stale = planClaudeCode({ ...entry, env: { CLAUDE_BIN: "/new/claude" } }, home);
    assert.equal(stale.upToDate, false);
    assert.deepEqual(stale.conflict?.env, entry.env);
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { duskfleet: { type: "stdio", command: entry.command, args: entry.args } } }),
    );
    const missing = planClaudeCode(entry, home);
    assert.equal(missing.upToDate, false);
    assert.deepEqual(missing.conflict?.env, {});
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { duskfleet: { type: "stdio", ...entry } } }),
    );

    const [code, desktop] = mcpStatus("linux", home, {});
    assert.deepEqual(
      { target: code.target, registered: code.registered, command: code.command, args: code.args },
      { target: "claude-code", registered: true, command: entry.command, args: entry.args },
    );
    assert.equal(desktop.target, "claude-desktop");
    assert.equal(desktop.registered, false);
    assert.equal(desktop.error, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- through the CLI ----------------------------------------------------------------

function makeHome() {
  const root = tempDir("duskfleet-mcpreg-");
  const home = path.join(root, "home");
  mkdirSync(home);
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nclaude:\n  binary: ${JSON.stringify(fakeBinary)}\n`,
  );
  const env = {
    DUSKFLEET_CONFIG: configDir,
    DUSKFLEET_LOG_LEVEL: "warn",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: "",
    APPDATA: path.join(home, "AppData", "Roaming"),
  };
  const desktop = desktopConfigPath(process.platform, home, env);
  return { root, home, env, desktop };
}

function cli(env, args) {
  return spawnSync(process.execPath, [cliEntry, ...args], { env: testEnv(env), encoding: "utf8", input: "" });
}

test("cli: claude-desktop --dry-run prints the diff and leaves the file and its directory untouched", () => {
  const { root, env, desktop } = makeHome();
  try {
    mkdirSync(path.dirname(desktop), { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: "o" } } });
    writeFileSync(desktop, original);
    const before = readdirSync(path.dirname(desktop));
    const r = cli(env, ["mcp", "register", "--target", "claude-desktop", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /@@ mcpServers\.duskfleet @@/);
    assert.match(r.stdout, /\+"duskfleet": \{/);
    assert.match(r.stdout, /\+\s+"CLAUDE_BIN": "/);
    assert.match(r.stdout, /dry run: nothing was written/);
    assert.deepEqual(readdirSync(path.dirname(desktop)), before);
    assert.equal(readFileSync(desktop, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: claude-desktop --yes backs up, then writes; without --yes off a terminal nothing changes; malformed file refused", () => {
  const { root, env, desktop } = makeHome();
  try {
    mkdirSync(path.dirname(desktop), { recursive: true });
    const original = JSON.stringify({ mcpServers: {} });
    writeFileSync(desktop, original);

    const asked = cli(env, ["mcp", "register", "--target", "claude-desktop"]);
    assert.equal(asked.status, 1);
    assert.match(asked.stderr, /pass --yes/);
    assert.equal(readFileSync(desktop, "utf8"), original);

    const r = cli(env, ["mcp", "register", "--target", "claude-desktop", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    const backups = readdirSync(path.dirname(desktop)).filter((f) => f.startsWith("claude_desktop_config.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(path.dirname(desktop), backups[0]), "utf8"), original);
    const entry = JSON.parse(readFileSync(desktop, "utf8")).mcpServers.duskfleet;
    assert.equal(entry.command, process.execPath);
    assert.ok(path.isAbsolute(entry.args[0]) && entry.args[0].endsWith(path.join("dist", "index.js")));

    const again = cli(env, ["mcp", "register", "--target", "claude-desktop", "--yes"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to do/);

    writeFileSync(desktop, "{ broken");
    const bad = cli(env, ["mcp", "register", "--target", "claude-desktop", "--yes"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not valid JSON/);
    assert.equal(readFileSync(desktop, "utf8"), "{ broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: claude-code --dry-run prints the claude mcp add command; mcp status reports both targets", () => {
  const { root, env } = makeHome();
  try {
    const r = cli(env, ["mcp", "register", "--target", "claude-code", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /will run:\n {2}claude mcp add duskfleet --scope user .*-- /);

    const wrong = cli(env, ["mcp", "register", "--target", "cowork"]);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /--target claude-code or claude-desktop/);

    const s = cli(env, ["mcp", "status"]);
    assert.equal(s.status, 0, s.stderr);
    const status = JSON.parse(s.stdout);
    assert.deepEqual(
      status.map((t) => [t.target, t.registered]),
      [
        ["claude-code", false],
        ["claude-desktop", false],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
