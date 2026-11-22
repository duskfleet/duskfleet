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
import { desktopSnippet, mcpServerConfig } from "@duskfleet/core";
import {
  applyDesktop,
  backupPath,
  claudeCodeAddArgs,
  dataDirWarnings,
  desktopConfigPath,
  hostBinEnv,
  hostCliAddArgs,
  lineDiff,
  mcpStatus,
  parseHostListing,
  planClaudeCode,
  planDesktop,
  serverEntry,
  withDirs,
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

test("mcpServerConfig (shared with the dashboard's /mcp page) exports config and data only when needed", () => {
  // An installed package (no checkout above the entry): the config is always exported.
  const installed = mcpServerConfig({
    nodeBin: "/opt/node/bin/node",
    serverEntry: "/opt/lib/node_modules/duskfleet/dist/index.js",
    claudeBin: "/opt/claude",
    config: { configDir: "/home/me/.config/duskfleet", dataDir: "/data/df", dataSource: "env" },
    version: "1.2.3",
    platform: "linux",
  });
  assert.equal(installed.form, "path");
  assert.deepEqual(installed.entry, {
    command: "/opt/node/bin/node",
    args: ["/opt/lib/node_modules/duskfleet/dist/index.js"],
    env: { CLAUDE_BIN: "/opt/claude", DUSKFLEET_CONFIG: "/home/me/.config/duskfleet", DUSKFLEET_DATA: "/data/df" },
  });
  // The same entry the CLI builds by hand from serverEntry.
  assert.deepEqual(
    installed.entry,
    serverEntry({
      nodeBin: "/opt/node/bin/node",
      serverEntry: "/opt/lib/node_modules/duskfleet/dist/index.js",
      claudeBin: "/opt/claude",
      configDir: "/home/me/.config/duskfleet",
      dataDir: "/data/df",
      version: "1.2.3",
    }).entry,
  );
  // From npx's cache: the pinned npx form, same env.
  const npx = mcpServerConfig({
    nodeBin: "/opt/node/bin/node",
    serverEntry: "/home/me/.npm/_npx/abc/node_modules/duskfleet/dist/index.js",
    claudeBin: null,
    config: { configDir: "/home/me/.config/duskfleet", dataDir: "/x", dataSource: "config" },
    version: "1.2.3",
    platform: "linux",
  });
  assert.equal(npx.form, "npx");
  assert.deepEqual(npx.entry.args, ["-y", "-p", "duskfleet@1.2.3", "duskfleet-mcp"]);
  assert.deepEqual(npx.entry.env, { DUSKFLEET_CONFIG: "/home/me/.config/duskfleet" });
  assert.deepEqual(JSON.parse(desktopSnippet(npx.entry)), { mcpServers: { duskfleet: npx.entry } });
});

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

test("copilot / codex mcp add: name first, --env per variable, -- then the command; listings of both CLIs", () => {
  assert.deepEqual(hostCliAddArgs(entry), [
    "mcp",
    "add",
    "duskfleet",
    "--env",
    "CLAUDE_BIN=/opt/claude",
    "--",
    "/opt/node/bin/node",
    "/opt/duskfleet/dist/index.js",
  ]);
  // Copilot: { mcpServers: { name: {...} } }; a builtin server of that name is not ours.
  const copilot = JSON.stringify({
    mcpServers: {
      "github-mcp-server": { type: "http", source: "builtin", enabled: true },
      duskfleet: { type: "stdio", command: "/n", args: ["/i.js"], source: "user", enabled: true },
    },
  });
  assert.deepEqual(parseHostListing("copilot", copilot), { command: "/n", args: ["/i.js"], env: {}, envKnown: false });
  assert.equal(
    parseHostListing("copilot", JSON.stringify({ mcpServers: { duskfleet: { type: "http", source: "builtin" } } })),
    null,
  );
  // Only source "user" is the registration: a workspace or plugin server of that name is not.
  for (const source of ["workspace", "plugin"]) {
    const other = { mcpServers: { duskfleet: { type: "stdio", command: "/n", args: ["/i.js"], source } } };
    assert.equal(parseHostListing("copilot", JSON.stringify(other)), null, source);
  }
  assert.equal(parseHostListing("copilot", JSON.stringify({ mcpServers: {} })), null);
  assert.throws(() => parseHostListing("copilot", "[]"), /mcpServers/);
  // Codex: [{ name, transport: { type, command, args, env } }]; env null = none, known.
  const codex = JSON.stringify([
    { name: "other", enabled: true, transport: { type: "stdio", command: "o", args: [], env: null } },
    { name: "duskfleet", enabled: true, transport: { type: "stdio", command: "/n", args: ["/i.js"], env: null } },
  ]);
  assert.deepEqual(parseHostListing("codex", codex), { command: "/n", args: ["/i.js"], env: {}, envKnown: true });
  assert.equal(parseHostListing("codex", "[]"), null);
  assert.throws(() => parseHostListing("codex", "{}"), /not an array/);
  // COPILOT_BIN / CODEX_BIN only when the binary was not found on PATH.
  assert.deepEqual(hostBinEnv("copilot", "/x/copilot", null, {}), {});
  assert.deepEqual(hostBinEnv("copilot", "/x/copilot", "/x/copilot", {}), { COPILOT_BIN: "/x/copilot" });
  assert.deepEqual(hostBinEnv("codex", "/y/codex", null, { CODEX_BIN: "/y/codex" }), { CODEX_BIN: "/y/codex" });
});

test("one database: hosts on the same directories give no warning; another data directory is named with both paths", () => {
  const root = tempDir("duskfleet-dirs-");
  try {
    const config = path.join(root, "config");
    mkdirSync(config);
    writeFileSync(path.join(config, "duskfleet.yaml"), "data_dir: ../data\n");
    const data = path.join(root, "data");
    const host = (target, env) => ({
      target,
      configPath: "/x",
      registered: true,
      command: "/n",
      args: ["/nowhere/dist/index.js"],
      env,
      error: null,
    });
    const same = withDirs(
      [host("claude-code", { DUSKFLEET_CONFIG: config }), host("codex", { DUSKFLEET_CONFIG: config })],
      data,
    );
    assert.deepEqual(
      same.map((s) => [s.configDir, s.dataDir, s.sameData]),
      [
        [config, data, true],
        [config, data, true],
      ],
    );
    assert.deepEqual(dataDirWarnings(same, data), []);

    const other = path.join(root, "elsewhere");
    const mixed = withDirs(
      [
        host("claude-code", { DUSKFLEET_CONFIG: config }),
        host("copilot", { DUSKFLEET_CONFIG: config, DUSKFLEET_DATA: other }),
        { ...host("claude-desktop", {}), registered: false, command: null },
      ],
      data,
    );
    assert.deepEqual(
      mixed.map((s) => s.sameData),
      [true, false, null],
    );
    const warnings = dataDirWarnings(mixed, data);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^Copilot CLI uses the data directory /);
    assert.ok(warnings[0].includes(other) && warnings[0].includes(data), warnings[0]);
    // Without a config of this install, the first registered host is the reference.
    assert.equal(dataDirWarnings(withDirs(mixed, null), null).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

    const s = cli(env, ["mcp", "status", "--json"]);
    assert.equal(s.status, 0, s.stderr);
    const status = JSON.parse(s.stdout);
    const human = cli(env, ["mcp", "status"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^HOST +CONFIG +ENTRY +RUNS\n/);
    assert.match(human.stdout, /\nClaude Code +\S+ +– no +-\n/);
    assert.match(human.stdout, /\nClaude Desktop +\S.* +– no +-\n/);
    assert.match(human.stdout, /\nregister: duskfleet mcp register --target claude-code\n/);
    assert.deepEqual(
      status.map((t) => [t.target, t.registered]),
      [
        ["claude-code", false],
        ["claude-desktop", false],
        ["copilot", false],
        ["codex", false],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Copilot CLI and Codex CLI (issue #477): through fake-copilot.js / fake-codex.js (COPILOT_BIN and
// CODEX_BIN from helpers.js), their user configuration in a temp file, never the real CLI.
for (const [target, title] of [
  ["copilot", "Copilot CLI"],
  ["codex", "Codex CLI"],
]) {
  const stateVar = target === "copilot" ? "FAKE_COPILOT_MCP_STATE" : "FAKE_CODEX_MCP_STATE";
  const binVar = target === "copilot" ? "COPILOT_BIN" : "CODEX_BIN";
  /** The duskfleet entry the fake holds, in its own shape. */
  const registered = (state) => {
    if (!existsSync(state)) return null;
    const raw = JSON.parse(readFileSync(state, "utf8"));
    return target === "copilot"
      ? (raw.mcpServers.duskfleet ?? null)
      : (raw.find((s) => s.name === "duskfleet")?.transport ?? null);
  };

  test(`cli: ${target} --dry-run prints the ${target} mcp add command and the directories, writes nothing`, () => {
    const { root, env } = makeHome();
    try {
      const state = path.join(root, "state.json");
      const r = cli({ ...env, [stateVar]: state }, ["mcp", "register", "--target", target, "--dry-run"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`\\nconfig: ${path.join(root, "config").replace(/[\\/.]/g, "\\$&")}\\n`));
      assert.match(r.stdout, new RegExp(`\\ndata: ${path.join(root, "data").replace(/[\\/.]/g, "\\$&")}\\n`));
      assert.match(
        r.stdout,
        new RegExp(`will run:\\n {2}${target} mcp add duskfleet --env .*${binVar}=.* -- \\S+ \\S+index\\.js\\n`),
      );
      assert.equal(existsSync(state), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`cli: ${target} --yes registers through the CLI; again = nothing to do; a different entry is refused; status reports it`, () => {
    const { root, env } = makeHome();
    try {
      const state = path.join(root, "state.json");
      const e = { ...env, [stateVar]: state };
      const asked = cli(e, ["mcp", "register", "--target", target]);
      assert.equal(asked.status, 1);
      assert.match(asked.stderr, /pass --yes/);
      assert.equal(existsSync(state), false);

      const r = cli(e, ["mcp", "register", "--target", target, "--yes"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`registered in ${title}`));
      if (target === "copilot")
        assert.match(r.stdout, /organization's Copilot policy may disable third-party MCP servers/);
      else assert.doesNotMatch(r.stdout, /policy/);
      const added = registered(state);
      assert.equal(added.command, process.execPath);
      assert.ok(added.args[0].endsWith(path.join("dist", "index.js")));
      assert.equal(added.env[binVar], process.env[binVar]);
      assert.equal(added.env.DUSKFLEET_CONFIG, path.join(root, "config"));

      const again = cli(e, ["mcp", "register", "--target", target, "--yes"]);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /nothing to do/);

      const s = cli(e, ["mcp", "status", "--json"]);
      assert.equal(s.status, 0, s.stderr);
      const row = JSON.parse(s.stdout).find((t) => t.target === target);
      assert.equal(row.registered, true);
      assert.equal(row.command, process.execPath);
      assert.equal(row.dataDir, path.join(root, "data"));
      assert.equal(row.sameData, true);
      const human = cli(e, ["mcp", "status"]);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, new RegExp(`\\n${title} +\\S.* +✓ yes +\\S`));
      assert.match(human.stdout, /\n {2}└ data \S+\n {2}└ config \S+/);
      assert.doesNotMatch(human.stdout, /another database/);

      // Someone registered another install: refused, with the command that removes it.
      const other = JSON.parse(readFileSync(state, "utf8"));
      if (target === "copilot") other.mcpServers.duskfleet.args = ["/elsewhere/dist/index.js"];
      else other[0].transport.args = ["/elsewhere/dist/index.js"];
      writeFileSync(state, JSON.stringify(other));
      const refused = cli(e, ["mcp", "register", "--target", target, "--yes"]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, new RegExp(`Remove it first \\(${target} mcp remove duskfleet\\)`));
      assert.deepEqual(registered(state).args, ["/elsewhere/dist/index.js"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("cli: a failing copilot mcp list with an empty stderr is an error, never an empty listing", () => {
  const { root, env } = makeHome();
  try {
    const state = path.join(root, "state.json");
    const e = {
      ...env,
      FAKE_COPILOT_MCP_STATE: state,
      FAKE_COPILOT_MCP_LIST_EXIT: "1",
      FAKE_COPILOT_MCP_LIST_QUIET: "1",
    };
    const r = cli(e, ["mcp", "register", "--target", "copilot", "--yes"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mcp list --json failed: exit 1/);
    assert.equal(existsSync(state), false, "no mcp add after a failed listing");
    const s = JSON.parse(cli(e, ["mcp", "status", "--json"]).stdout).find((t) => t.target === "copilot");
    assert.equal(s.registered, false);
    assert.match(s.error, /failed: exit 1$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a copilot workspace server named duskfleet is not the registration; register adds the user entry", () => {
  const { root, env } = makeHome();
  try {
    const state = path.join(root, "state.json");
    const workspace = { duskfleet: { type: "stdio", command: process.execPath, args: ["/repo/dist/index.js"] } };
    const e = { ...env, FAKE_COPILOT_MCP_STATE: state, FAKE_COPILOT_MCP_WORKSPACE: JSON.stringify(workspace) };
    const before = JSON.parse(cli(e, ["mcp", "status", "--json"]).stdout).find((t) => t.target === "copilot");
    assert.equal(before.registered, false);
    const r = cli(e, ["mcp", "register", "--target", "copilot", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /nothing to do/);
    assert.doesNotMatch(r.stderr, /Remove it first/);
    assert.ok(JSON.parse(readFileSync(state, "utf8")).mcpServers.duskfleet, "the user entry was added");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a host on another data directory is named by mcp status and by doctor's advice line", () => {
  const { root, env } = makeHome();
  try {
    const state = path.join(root, "codex.json");
    const elsewhere = path.join(root, "other-data");
    writeFileSync(
      state,
      JSON.stringify([
        {
          name: "duskfleet",
          enabled: true,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: ["/elsewhere/dist/index.js"],
            env: { DUSKFLEET_CONFIG: path.join(root, "config"), DUSKFLEET_DATA: elsewhere },
          },
        },
      ]),
    );
    const e = { ...env, FAKE_CODEX_MCP_STATE: state };
    const human = cli(e, ["mcp", "status"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Codex CLI uses the data directory \S*other-data, this install uses \S*data: /);
    const json = JSON.parse(cli(e, ["mcp", "status", "--json"]).stdout);
    const codex = json.find((t) => t.target === "codex");
    assert.equal(codex.dataDir, elsewhere);
    assert.equal(codex.sameData, false);

    const doctor = cli(e, ["doctor", "--json"]);
    const report = JSON.parse(doctor.stdout);
    assert.deepEqual(report.mcpHosts.registered, ["codex"]);
    assert.equal(report.mcpHosts.warnings.length, 1);
    assert.match(report.mcpHosts.warnings[0], /^Codex CLI uses the data directory /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
