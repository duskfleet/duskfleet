/**
 * config/duskfleet.yaml edits from the dashboard's Settings page: comments survive, a value the
 * loader refuses rolls the file back, keys outside the editable list are refused.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig, readGlobalFile, writeGlobalFile } from "@duskfleet/core";

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const YAML = `# Duskfleet global configuration.
data_dir: ../data
allowed_project_roots: []
max_concurrent_runs: 8 # hard cap
scheduler:
  enabled: true            # kill switch
  tick_seconds: 30
claude:
  # Which settings files runs load.
  setting_sources: [project, local]
`;

function makeConfig() {
  const root = mkdtempSync(path.join(tmpdir(), "df-core-global-"));
  roots.push(root);
  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(root, "data"), { recursive: true });
  writeFileSync(path.join(configDir, "duskfleet.yaml"), YAML);
  return configDir;
}

test("readGlobalFile returns the values as written, absent keys undefined", () => {
  const info = readGlobalFile(makeConfig());
  assert.equal(info.values.max_concurrent_runs, 8);
  assert.equal(info.values["scheduler.enabled"], true);
  assert.deepEqual(info.values["claude.setting_sources"], ["project", "local"]);
  assert.deepEqual(info.values.allowed_project_roots, []);
  assert.equal(info.values.max_concurrent_per_agent, undefined);
  assert.ok(!Number.isNaN(Date.parse(info.modifiedAt)));
});

test("writeGlobalFile sets values, adds missing keys and keeps comments", () => {
  const dir = makeConfig();
  writeGlobalFile(dir, {
    max_concurrent_runs: 4,
    "scheduler.enabled": false,
    max_concurrent_per_agent: 2,
    "claude.setting_sources": ["project"],
    "claude.binary": null,
  });
  const text = readFileSync(path.join(dir, "duskfleet.yaml"), "utf8");
  assert.match(text, /^# Duskfleet global configuration\./);
  assert.match(text, /max_concurrent_runs: 4 # hard cap/);
  assert.match(text, /enabled: false +# kill switch/);
  assert.match(
    text,
    /# Which settings files runs load\.\n {2}setting_sources: \[ project \]|setting_sources: \[project\]/,
  );
  const cfg = loadConfig(dir);
  assert.equal(cfg.maxConcurrentRuns, 4);
  assert.equal(cfg.maxConcurrentPerAgent, 2);
  assert.equal(cfg.scheduler.enabled, false);
  assert.deepEqual(cfg.claude.settingSources, ["project"]);
});

test("writeGlobalFile restores the file when the loader refuses the change", () => {
  const dir = makeConfig();
  assert.throws(() => writeGlobalFile(dir, { "scheduler.tick_seconds": 2 }));
  assert.throws(() => writeGlobalFile(dir, { default_agent: "nobody" }), /default_agent "nobody" not found/);
  assert.equal(readFileSync(path.join(dir, "duskfleet.yaml"), "utf8"), YAML);
});

test("writeGlobalFile refuses keys the Settings page does not edit", () => {
  const dir = makeConfig();
  assert.throws(() => writeGlobalFile(dir, { data_dir: "/tmp" }), /not editable/);
  assert.equal(readFileSync(path.join(dir, "duskfleet.yaml"), "utf8"), YAML);
});
