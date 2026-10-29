/**
 * Where config and data are found (#183): DUSKFLEET_CONFIG, then a repo-local config/ found by
 * walking up, then the user-level directory (XDG on Linux and macOS, %APPDATA% on Windows).
 * Data follows the config unless DUSKFLEET_DATA is set.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  dataDirFor,
  initUserConfig,
  loadConfig,
  locateConfig,
  STARTER_CONFIG,
  userConfigDir,
  userDataDir,
} from "@duskfleet/core";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const bundleDir = path.join(here, "..", "..", "duskfleet", "dist");
const repoNodeModules = path.join(here, "..", "..", "..", "node_modules");

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "duskfleet-loc-"));
}

/** A fake home with XDG variables pointing inside it; nothing of the real user is read. */
function ctxFor(root, extra = {}) {
  const home = path.join(root, "home");
  return {
    home,
    platform: "linux",
    env: { XDG_CONFIG_HOME: path.join(home, "xdg-config"), XDG_DATA_HOME: path.join(home, "xdg-data"), ...extra },
  };
}

test("user-level directories: XDG variables, their defaults, relative values ignored, Windows", () => {
  const home = "/h";
  assert.equal(userConfigDir({ home, platform: "linux", env: {} }), "/h/.config/duskfleet");
  assert.equal(userDataDir({ home, platform: "darwin", env: {} }), "/h/.local/share/duskfleet");
  assert.equal(userConfigDir({ home, platform: "linux", env: { XDG_CONFIG_HOME: "/x/c" } }), "/x/c/duskfleet");
  assert.equal(userDataDir({ home, platform: "linux", env: { XDG_DATA_HOME: "/x/d" } }), "/x/d/duskfleet");
  assert.equal(userConfigDir({ home, platform: "linux", env: { XDG_CONFIG_HOME: "rel" } }), "/h/.config/duskfleet");
  const win = { home: "C:\\Users\\me", platform: "win32" };
  assert.equal(
    userConfigDir({ ...win, env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" } }),
    "C:\\Users\\me\\AppData\\Roaming\\duskfleet",
  );
  assert.equal(userDataDir({ ...win, env: {} }), "C:\\Users\\me\\AppData\\Local\\duskfleet");
});

test("precedence: DUSKFLEET_CONFIG beats a repo-local config/, which beats the user-level one", () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "config"), { recursive: true });
    writeFileSync(path.join(repo, "config", "duskfleet.yaml"), "default_agent: null\n");
    const inside = path.join(repo, "packages", "x");
    mkdirSync(inside, { recursive: true });
    const outside = path.join(root, "elsewhere");
    mkdirSync(outside);
    const ctx = ctxFor(root);
    const user = path.join(ctx.env.XDG_CONFIG_HOME, "duskfleet");

    const envWins = locateConfig(inside, { ...ctx, env: { ...ctx.env, DUSKFLEET_CONFIG: path.join(root, "own") } });
    assert.equal(envWins.source, "env");
    assert.equal(envWins.configDir, path.join(root, "own"));
    assert.deepEqual(envWins.lookup, { env: path.join(root, "own"), repo: path.join(repo, "config"), user });

    const repoWins = locateConfig(inside, ctx);
    assert.equal(repoWins.source, "repo");
    assert.equal(repoWins.configDir, path.join(repo, "config"));

    const userLevel = locateConfig(outside, ctx);
    assert.equal(userLevel.source, "user");
    assert.equal(userLevel.configDir, user);
    assert.deepEqual(userLevel.lookup, { env: null, repo: null, user });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("data follows the config unless DUSKFLEET_DATA is set", () => {
  const root = tempRoot();
  try {
    const ctx = ctxFor(root);
    const repoConfig = path.join(root, "repo", "config");
    assert.deepEqual(dataDirFor(repoConfig, null, ctx), {
      dataDir: path.join(root, "repo", "data"),
      dataSource: "config",
    });
    assert.deepEqual(dataDirFor(repoConfig, "../elsewhere", ctx), {
      dataDir: path.join(root, "repo", "elsewhere"),
      dataSource: "config",
    });
    assert.deepEqual(dataDirFor(userConfigDir(ctx), null, ctx), { dataDir: userDataDir(ctx), dataSource: "user" });
    const forced = path.join(root, "forced");
    for (const configDir of [repoConfig, userConfigDir(ctx)]) {
      assert.deepEqual(dataDirFor(configDir, "../data", { ...ctx, env: { ...ctx.env, DUSKFLEET_DATA: forced } }), {
        dataDir: forced,
        dataSource: "env",
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initUserConfig writes the starter config once, never overwrites, and the result loads", () => {
  const root = tempRoot();
  try {
    const ctx = ctxFor(root);
    const first = initUserConfig(ctx);
    assert.equal(first.configDir, userConfigDir(ctx));
    assert.equal(first.dataDir, userDataDir(ctx));
    assert.deepEqual(first.created, [path.join(first.configDir, "duskfleet.yaml")]);
    assert.equal(readFileSync(first.created[0], "utf8"), STARTER_CONFIG);
    assert.ok(existsSync(first.dataDir));

    writeFileSync(first.created[0], "max_concurrent_runs: 3\n");
    assert.deepEqual(initUserConfig(ctx).created, [], "an existing config is left alone");
    assert.equal(readFileSync(first.created[0], "utf8"), "max_concurrent_runs: 3\n");

    writeFileSync(first.created[0], STARTER_CONFIG);
    const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME };
    process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = ctx.env.XDG_DATA_HOME;
    try {
      const config = loadConfig(first.configDir);
      assert.equal(config.dataDir, first.dataDir);
      assert.equal(config.dataSource, "user");
      assert.equal(config.defaultAgent, null);
      assert.equal(config.agents.size, 0, "the starter ships no agent");
    } finally {
      for (const [k, v] of [
        ["XDG_CONFIG_HOME", saved.cfg],
        ["XDG_DATA_HOME", saved.data],
      ]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the built bin outside any checkout: doctor uses the user-level config and data, exit 0", () => {
  assert.ok(existsSync(path.join(bundleDir, "cli.js")), "packages/duskfleet/dist is missing: run npm run build");
  const root = tempRoot();
  try {
    // A copy of the published package with no repository above it (node_modules linked for yaml/zod/sdk).
    const pkg = path.join(root, "pkg");
    cpSync(path.join(bundleDir, ".."), pkg, { recursive: true, filter: (src) => !src.includes("node_modules") });
    symlinkSync(repoNodeModules, path.join(pkg, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const ctx = ctxFor(root);
    const cwd = path.join(root, "empty");
    mkdirSync(cwd);
    const env = testEnv({
      HOME: ctx.home,
      XDG_CONFIG_HOME: ctx.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: ctx.env.XDG_DATA_HOME,
      CLAUDE_BIN: fakeBinary,
      DUSKFLEET_LOG_LEVEL: "warn",
    });
    delete env.DUSKFLEET_CONFIG;
    const doctor = () =>
      spawnSync(process.execPath, [path.join(pkg, "dist", "cli.js"), "doctor"], { cwd, env, encoding: "utf8" });

    const before = doctor();
    assert.equal(before.status, 1, "no starter config yet");
    assert.match(before.stderr, /Config file not found: .*xdg-config.*duskfleet\.yaml\nFirst time here\?/);

    initUserConfig(ctx);
    const after = doctor();
    assert.equal(after.status, 0, after.stderr);
    const report = JSON.parse(after.stdout);
    assert.equal(report.configSource, "user");
    assert.equal(report.configDir, userConfigDir(ctx));
    assert.deepEqual(report.configLookup, { env: null, repo: null, user: userConfigDir(ctx) });
    assert.equal(report.dataSource, "user");
    assert.equal(report.dataDir, userDataDir(ctx));
    assert.ok(existsSync(path.join(userDataDir(ctx), "duskfleet.db")), "the database is in the user data directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clone still uses its config/ and data/ with no env var set", () => {
  // Located from the CLI's own entry, like bootstrap; the real database is not opened.
  const repoRoot = path.resolve(here, "..", "..", "..");
  const root = tempRoot();
  try {
    const ctx = ctxFor(root);
    const found = locateConfig(path.join(here, "..", "dist", "cli.js"), ctx);
    assert.equal(found.source, "repo");
    assert.equal(found.configDir, path.join(repoRoot, "config"));
    const yaml = readFileSync(path.join(found.configDir, "duskfleet.yaml"), "utf8");
    const setting = /^data_dir:\s*(\S+)/m.exec(yaml)?.[1] ?? null;
    assert.equal(dataDirFor(found.configDir, setting, ctx).dataDir, path.join(repoRoot, "data"));
    assert.equal(dataDirFor(found.configDir, null, ctx).dataDir, path.join(repoRoot, "data"), "also by default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
