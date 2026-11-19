/**
 * Issue #463: a scheduled link run notes that its project agent file (the persona, inside the
 * project) changed since the schedule's previous run. A notice, never a block or a review reason.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import {
  ClaudeCodeExecutor,
  compareProjectAgent,
  loadConfig,
  openDatabase,
  projectAgentDefinitionHash,
  RunManager,
  RunRepository,
  summarizeRun,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

function makeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-persona-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  const realProject = realpathSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  writeFileSync(
    path.join(configDir, "agents", "linked.md"),
    `---\nclaude_agent: worker\npermission_mode: dontAsk\n---\n`,
  );
  writeFileSync(
    path.join(configDir, "agents", "helper-link.md"),
    `---\nclaude_agent: helper\npermission_mode: dontAsk\n---\n`,
  );
  const persona = path.join(realProject, ".claude", "agents", "worker.md");
  writeFileSync(persona, "---\nname: worker\ndescription: works\n---\nv1\n");
  writeFileSync(
    path.join(realProject, ".claude", "agents", "helper.md"),
    "---\nname: helper\ndescription: helps\n---\nother\n",
  );
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const executor = new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true });
  const runs = new RunManager(config, new RunRepository(db), executor);
  const cleanup = async () => {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project: realProject, persona, runs, db, cleanup };
}

async function fire(app, agentId, scheduleId = "sched-1") {
  const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId, scheduleId });
  return app.runs.waitForRun(started.id, 10_000);
}

const personaNotes = (app, runId) =>
  app.runs.events(runId).filter((e) => e.type === "note" && /project agent file/.test(e.payload?.message ?? ""));

test("compareProjectAgent: null without both hashes, else the change", () => {
  assert.equal(compareProjectAgent(null, { id: "a", projectAgentHash: "h1" }), null);
  assert.equal(compareProjectAgent("h1", null), null);
  assert.equal(compareProjectAgent("h1", { id: "a", projectAgentHash: null }), null);
  assert.deepEqual(compareProjectAgent("h2", { id: "a", projectAgentHash: "h1" }), {
    previousRunId: "a",
    previousHash: "h1",
    hash: "h2",
    changed: true,
  });
  assert.equal(compareProjectAgent("h1", { id: "a", projectAgentHash: "h1" }).changed, false);
});

test("same persona on two scheduled fires: hash recorded, no note", async () => {
  const app = makeApp();
  try {
    const first = await fire(app, "linked");
    assert.equal(first.projectAgentHash, projectAgentDefinitionHash(app.project, "worker"));
    assert.match(first.projectAgentHash, /^[0-9a-f]{12}$/);
    assert.equal(summarizeRun(first).projectAgentHash, first.projectAgentHash);
    assert.equal(app.runs.projectAgentChange(first), null, "first run of the schedule: nothing to compare");
    const second = await fire(app, "linked");
    assert.equal(second.projectAgentHash, first.projectAgentHash);
    assert.deepEqual(personaNotes(app, second.id), []);
    assert.equal(app.runs.projectAgentChange(second).changed, false);
  } finally {
    await app.cleanup();
  }
});

test("persona edited between two scheduled fires: one note with both hashes, run unaffected", async () => {
  const app = makeApp();
  try {
    const first = await fire(app, "linked");
    writeFileSync(app.persona, "---\nname: worker\ndescription: works\n---\nv2, now with more tools\n");
    const second = await fire(app, "linked");
    assert.notEqual(second.projectAgentHash, first.projectAgentHash);
    const notes = personaNotes(app, second.id);
    assert.equal(notes.length, 1);
    assert.ok(notes[0].payload.message.includes(first.projectAgentHash));
    assert.ok(notes[0].payload.message.includes(second.projectAgentHash));
    assert.ok(notes[0].payload.message.includes(first.id));
    assert.deepEqual(app.runs.projectAgentChange(second), {
      previousRunId: first.id,
      previousHash: first.projectAgentHash,
      hash: second.projectAgentHash,
      changed: true,
    });
    // A notice only: same status and review reasons as the unchanged first run.
    assert.equal(second.status, first.status);
    assert.deepEqual(second.reviewReasons, first.reviewReasons);
    assert.deepEqual(personaNotes(app, first.id), []);
    // Another schedule's run is not this schedule's previous run.
    const other = await fire(app, "linked", "sched-2");
    assert.equal(app.runs.projectAgentChange(other), null);
  } finally {
    await app.cleanup();
  }
});

test("schedule switched to another link agent: its files are never compared", async () => {
  const app = makeApp();
  try {
    const first = await fire(app, "linked");
    const switched = await fire(app, "helper-link");
    assert.ok(switched.projectAgentHash);
    assert.notEqual(switched.projectAgentHash, first.projectAgentHash);
    assert.equal(app.runs.projectAgentChange(switched), null, "first run of this agent on the schedule");
    assert.deepEqual(personaNotes(app, switched.id), []);
    // Back to the first agent: compared with its own previous run, not with the other agent's.
    const back = await fire(app, "linked");
    assert.equal(app.runs.projectAgentChange(back).previousRunId, first.id);
    assert.deepEqual(personaNotes(app, back.id), []);
  } finally {
    await app.cleanup();
  }
});

test("own agent: no persona hash, no note", async () => {
  const app = makeApp();
  try {
    await fire(app, "coder");
    const second = await fire(app, "coder");
    assert.equal(second.projectAgentHash, null);
    assert.equal(app.runs.projectAgentChange(second), null);
    assert.deepEqual(personaNotes(app, second.id), []);
  } finally {
    await app.cleanup();
  }
});

test("older previous run without a persona hash: no note", async () => {
  const app = makeApp();
  try {
    const first = await fire(app, "linked");
    app.db.prepare("UPDATE runs SET project_agent_hash = NULL WHERE id = ?").run(first.id);
    writeFileSync(app.persona, "---\nname: worker\ndescription: works\n---\nv2\n");
    const second = await fire(app, "linked");
    assert.ok(second.projectAgentHash);
    assert.equal(app.runs.projectAgentChange(second), null);
    assert.deepEqual(personaNotes(app, second.id), []);
  } finally {
    await app.cleanup();
  }
});
