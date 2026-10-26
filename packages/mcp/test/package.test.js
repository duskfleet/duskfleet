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
import { fileURLToPath, pathToFileURL } from "node:url";
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
});

test("the duskfleet bundle carries core, imports no @duskfleet/core and ships no maps or declarations", () => {
  assert.ok(existsSync(path.join(bundleDir, "cli.js")), "packages/duskfleet/dist is missing: run npm run build");
  assert.ok(existsSync(path.join(bundleDir, "core", "index.js")), "core is bundled under dist/core");
  const templates = path.join(bundleDir, "templates") + path.sep;
  for (const file of walk(bundleDir)) {
    if (file.startsWith(templates)) {
      assert.match(file, /\.(md|yaml)$/, `unexpected template file in the bundle: ${file}`);
      continue;
    }
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

test("the bundle ships the starter config: writeStarterConfig fills a user config and run --agent example starts", async () => {
  const core = await import(pathToFileURL(path.join(bundleDir, "core", "index.js")).href);
  assert.equal(core.starterTemplatesDir(), path.join(bundleDir, "templates"), "templates resolve inside the bundle");
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-starter-"));
  try {
    const configDir = path.join(root, "user-config");
    const project = path.join(root, "scratch");
    mkdirSync(project);
    const first = core.writeStarterConfig(configDir);
    assert.deepEqual(first.created.map((f) => path.relative(configDir, f)).sort(), [
      path.join("agents", "example.md"),
      "duskfleet.yaml",
    ]);
    assert.deepEqual(first.kept, []);
    const second = core.writeStarterConfig(configDir);
    assert.deepEqual(second.created, [], "a second call writes nothing");
    assert.equal(second.kept.length, 2);

    const entry = path.join(bundleDir, "cli.js");
    const env = { DUSKFLEET_CONFIG: configDir, CLAUDE_BIN: fakeBinary };
    const agents = run(entry, ["agents"], env);
    assert.equal(agents.status, 0, agents.stderr);
    assert.match(agents.stdout, /"example"/);

    const started = run(
      entry,
      ["run", "--project", project, "--agent", "example", "--model", "haiku", "--", "Fix the failing test"],
      env,
    );
    assert.equal(started.status, 0, started.stderr);
    const runInfo = JSON.parse(started.stdout);
    assert.equal(runInfo.agentId, "example");
    assert.equal(runInfo.status, "completed");
    assert.ok(existsSync(path.join(configDir, "data", "duskfleet.db")), "data_dir of the starter is <config>/data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository's config/agents/example.md is the starter template, byte for byte", () => {
  const repo = path.join(here, "..", "..", "..");
  assert.equal(
    readFileSync(path.join(repo, "config", "agents", "example.md"), "utf8"),
    readFileSync(path.join(repo, "packages", "core", "templates", "agents", "example.md"), "utf8"),
  );
});

/** A minimal two-package workspace with a copy of scripts/check-pack.mjs, so the check runs on it. */
function packWorkspace(cliVersion, webVersion) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-pack-"));
  const write = (rel, content) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  write("package.json", JSON.stringify({ name: "ws", private: true, workspaces: ["packages/duskfleet", "apps/web"] }));
  write("packages/duskfleet/package.json", JSON.stringify({ name: "duskfleet", version: cliVersion }));
  for (const f of [
    "dist/cli.js",
    "dist/index.js",
    "dist/core/index.js",
    "dist/templates/duskfleet.yaml",
    "dist/templates/agents/example.md",
  ])
    write(`packages/duskfleet/${f}`, "");
  write("apps/web/package.json", JSON.stringify({ name: "@duskfleet/web", version: webVersion }));
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
