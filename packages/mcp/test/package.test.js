/**
 * The publishable `duskfleet` package (packages/duskfleet, assembled by scripts/assemble-package.mjs
 * during `npm run build`): the bundled CLI runs with core inside the package, and `--help` needs no
 * config (a fresh `npx duskfleet --help`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigNotFoundError, loadConfig, resolveConfigDir } from "@duskfleet/core";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const workspaceCli = path.join(here, "..", "dist", "cli.js");
const bundleDir = path.join(here, "..", "..", "duskfleet", "dist");

function run(entry, args, env = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "duskfleet-pkg-cwd-"));
  try {
    return spawnSync(process.execPath, [entry, ...args], {
      cwd, // outside the repository: nothing to find by walking up
      env: testEnv({ DUSKFLEET_LOG_LEVEL: "warn", ...env }),
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

test("--help prints the usage on stdout with exit 0 and loads no config; no command is still exit 2", () => {
  const missing = path.join(tmpdir(), "duskfleet-no-such-config");
  for (const flag of ["--help", "-h", "help"]) {
    const r = run(workspaceCli, [flag], { DUSKFLEET_CONFIG: missing });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Duskfleet - A fleet of agents for your own machine\.\n\nUsage:/);
    assert.match(r.stdout, /duskfleet doctor \[--probe\]/);
  }
  const none = run(workspaceCli, [], { DUSKFLEET_CONFIG: missing });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Usage:/);
  assert.match(none.stderr, /First time here\? Run: npx duskfleet init\n$/);
  assert.match(run(workspaceCli, ["--help"]).stdout, /First time here\? Run: npx duskfleet init\n$/);
});

test("a command that finds no config ends with the init hint; other errors do not", () => {
  const missing = run(workspaceCli, ["doctor"], { DUSKFLEET_CONFIG: path.join(tmpdir(), "duskfleet-no-such-config") });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /error: Config file not found: .*\nFirst time here\? Run: npx duskfleet init\n$/);

  // The other no-config case (no DUSKFLEET_CONFIG, nothing found walking up, no user-level
  // duskfleet.yaml yet) throws the same class; the bins live inside this repository, so check the
  // lookup in process from a temp dir.
  const saved = { config: process.env["DUSKFLEET_CONFIG"], xdg: process.env["XDG_CONFIG_HOME"] };
  delete process.env["DUSKFLEET_CONFIG"];
  const outside = mkdtempSync(path.join(tmpdir(), "duskfleet-no-repo-"));
  process.env["XDG_CONFIG_HOME"] = path.join(outside, "xdg-config");
  try {
    const configDir = resolveConfigDir(outside);
    assert.equal(configDir, path.join(outside, "xdg-config", "duskfleet"));
    assert.throws(
      () => loadConfig(configDir),
      (err) => err instanceof ConfigNotFoundError && /Config file not found/.test(err.message),
    );
  } finally {
    if (saved.config !== undefined) process.env["DUSKFLEET_CONFIG"] = saved.config;
    if (saved.xdg !== undefined) process.env["XDG_CONFIG_HOME"] = saved.xdg;
    else delete process.env["XDG_CONFIG_HOME"];
    rmSync(outside, { recursive: true, force: true });
  }

  // Not every error is a missing config: an invalid one gets no hint.
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-bad-config-"));
  try {
    writeFileSync(path.join(root, "duskfleet.yaml"), "max_concurrent_runs: -1\n");
    const bad = run(workspaceCli, ["doctor"], { DUSKFLEET_CONFIG: root });
    assert.equal(bad.status, 1);
    assert.doesNotMatch(bad.stderr, /duskfleet init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--version and -v print the package's own version, need no config, exit 0 (both bins)", () => {
  const ownVersion = (dir) => JSON.parse(readFileSync(path.join(dir, "..", "package.json"), "utf8")).version;
  const published = JSON.parse(readFileSync(path.join(bundleDir, "..", "package.json"), "utf8")).version;
  const workspaceDist = path.dirname(workspaceCli);
  assert.equal(ownVersion(workspaceDist), published, "@duskfleet/mcp and duskfleet carry the same version");
  for (const dir of [workspaceDist, bundleDir]) {
    for (const bin of ["cli.js", "index.js"]) {
      for (const flag of ["--version", "-v"]) {
        const r = run(path.join(dir, bin), [flag], {
          DUSKFLEET_CONFIG: path.join(tmpdir(), "duskfleet-no-such-config"),
        });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, `${published}\n`, `${dir}/${bin} ${flag}`);
      }
    }
  }
});

test("the duskfleet bundle carries core, imports no @duskfleet/core and ships no maps or declarations", () => {
  assert.ok(existsSync(path.join(bundleDir, "cli.js")), "packages/duskfleet/dist is missing: run npm run build");
  assert.ok(existsSync(path.join(bundleDir, "core", "index.js")), "core is bundled under dist/core");
  for (const file of walk(bundleDir)) {
    assert.ok(file.endsWith(".js") || path.basename(file) === "tools.json", `unexpected file in the bundle: ${file}`);
    if (!file.endsWith(".js")) continue;
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /(["'])@duskfleet\/core(\/[^"']*)?\1/, `${file} still imports @duskfleet/core`);
    assert.doesNotMatch(text, /sourceMappingURL/, `${file} points at a source map that is not shipped`);
  }
  for (const bin of ["cli.js", "index.js"]) {
    assert.match(
      readFileSync(path.join(bundleDir, bin), "utf8"),
      /^#!\/usr\/bin\/env node\n/,
      `${bin} keeps its shebang`,
    );
  }
});

test("the bundled CLI runs: --help without config, doctor on a config with the fake claude", () => {
  const entry = path.join(bundleDir, "cli.js");
  const help = run(entry, ["--help"], { DUSKFLEET_CONFIG: path.join(tmpdir(), "duskfleet-no-such-config") });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);

  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-pkg-"));
  try {
    const configDir = path.join(root, "config");
    mkdirSync(path.join(configDir, "agents"), { recursive: true });
    writeFileSync(
      path.join(configDir, "duskfleet.yaml"),
      `data_dir: ../data\nclaude:\n  binary: ${JSON.stringify(fakeBinary)}\n`,
    );
    const doctor = run(entry, ["doctor"], { DUSKFLEET_CONFIG: configDir });
    assert.equal(doctor.status, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.claudeVersion, "9.9.9 (fake)");
    assert.equal(report.configDir, configDir);
    assert.ok(existsSync(path.join(root, "data", "duskfleet.db")), "the bundled core opened the database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A minimal two-package workspace with a copy of scripts/check-pack.mjs, so the check runs on it. */
function packWorkspace(cliVersion, webVersion, cliBin = "dist/cli.js") {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-pack-"));
  const write = (rel, content) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  write("package.json", JSON.stringify({ name: "ws", private: true, workspaces: ["packages/duskfleet", "apps/web"] }));
  write(
    "packages/duskfleet/package.json",
    JSON.stringify({
      name: "duskfleet",
      version: cliVersion,
      bin: { duskfleet: cliBin, "duskfleet-mcp": "dist/index.js" },
    }),
  );
  for (const f of ["dist/cli.js", "dist/index.js", "dist/core/index.js"]) write(`packages/duskfleet/${f}`, "");
  write(
    "apps/web/package.json",
    JSON.stringify({ name: "@duskfleet/web", version: webVersion, bin: { "duskfleet-web": "bin/start.mjs" } }),
  );
  for (const f of ["bin/start.mjs", "next.config.mjs"]) write(`apps/web/${f}`, "");
  write("scripts/check-pack.mjs", readFileSync(path.join(here, "..", "..", "..", "scripts", "check-pack.mjs")));
  return root;
}

test("check-pack fails when the two packages carry different versions, passes when they match", () => {
  for (const [web, ok] of [
    ["0.1.0", true],
    ["0.2.0", false],
  ]) {
    const root = packWorkspace("0.1.0", web);
    try {
      const r = spawnSync(process.execPath, [path.join(root, "scripts", "check-pack.mjs")], {
        cwd: root,
        env: testEnv(),
        encoding: "utf8",
      });
      if (ok) {
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /both tarballs clean, version 0\.1\.0/);
      } else {
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stderr, /1 problem\(s\)/);
        assert.match(r.stderr, /versions differ: duskfleet@0\.1\.0, @duskfleet\/web@0\.2\.0/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// npm 11 drops a bin whose path starts with "./" while publishing (seen in the release run of
// 2026-10-28, "bin[duskfleet] script name dist/cli.js was invalid and removed"), so the gate
// refuses it before any tag is cut.
test("check-pack refuses a bin path npm would drop at publish time", () => {
  const root = packWorkspace("0.1.0", "0.1.0", "./dist/cli.js");
  try {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "check-pack.mjs")], {
      cwd: root,
      env: testEnv(),
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /1 problem\(s\)/);
    assert.match(r.stderr, /bin duskfleet -> \.\/dist\/cli\.js: npm drops this entry at publish/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
