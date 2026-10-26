/**
 * Starter config (packages/core/templates): writeStarterConfig copies a duskfleet.yaml and the
 * example agent into a fresh directory that loadConfig accepts, and never overwrites.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, STARTER_AGENT_ID, starterTemplatesDir, writeStarterConfig } from "@duskfleet/core";

const templates = fileURLToPath(new URL("../templates", import.meta.url));

test("starterTemplatesDir is packages/core/templates in the repository", () => {
  assert.equal(starterTemplatesDir(), templates);
});

test("writeStarterConfig fills an empty directory with a config that loads and the example agent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-starter-"));
  try {
    const configDir = path.join(root, "nested", "duskfleet");
    const first = writeStarterConfig(configDir);
    assert.equal(first.configDir, configDir);
    assert.deepEqual(first.created, [
      path.join(configDir, "agents", "example.md"),
      path.join(configDir, "duskfleet.yaml"),
    ]);
    assert.deepEqual(first.kept, []);

    const config = loadConfig(configDir);
    assert.equal(config.dataDir, path.join(configDir, "data"), "the starter keeps its data next to the config");
    assert.equal(config.defaultAgent, null);
    const agent = config.agents.get(STARTER_AGENT_ID);
    assert.ok(agent, "the example agent loads");
    assert.equal(agent.source, "builtin");
    assert.equal(agent.model, "haiku");
    assert.equal(agent.maxBudgetUsd, 0.5);
    assert.equal(agent.permissionMode, "dontAsk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeStarterConfig never overwrites: an existing file is kept as it is", () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-starter-"));
  try {
    writeStarterConfig(root);
    const yaml = path.join(root, "duskfleet.yaml");
    writeFileSync(yaml, "data_dir: elsewhere\n");
    const second = writeStarterConfig(root);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.kept, [path.join(root, "agents", "example.md"), yaml]);
    assert.equal(readFileSync(yaml, "utf8"), "data_dir: elsewhere\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeStarterConfig refuses a directory without templates", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "duskfleet-no-templates-"));
  try {
    assert.throws(() => writeStarterConfig(path.join(empty, "out"), empty), /starter templates not found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
