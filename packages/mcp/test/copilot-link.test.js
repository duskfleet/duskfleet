/**
 * Link agents on Copilot and the harness-neutral `project_agent` field (issue #466). The runs go
 * through fake-copilot.js, which replays the `link-*` fixtures of real Copilot CLI 1.0.114 runs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.js";
import {
  agentDefinitionHash,
  agentSpecSchema,
  CLAUDE_PROJECT_AGENTS,
  ClaudeCodeExecutor,
  COPILOT_PROJECT_AGENTS,
  CopilotExecutor,
  createCopilotState,
  HarnessRegistry,
  ingestCopilotLine,
  linkToolGaps,
  listProjectAgents,
  loadAgentDir,
  loadConfig,
  openDatabase,
  projectAgentDefinitionHash,
  RunManager,
  RunRepository,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");
const fakeCopilot = path.join(here, "fake-copilot.js");
const fixtures = path.join(here, "fixtures", "copilot");

/** A config whose agents are given as full Markdown, and a project with Copilot and Claude agents. */
function setup(agents) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-copilot-link-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(path.join(project, ".github", "agents"), { recursive: true });
  mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  writeFileSync(path.join(project, ".github", "agents", "pim.agent.md"), "---\ndescription: Pim\n---\nMEDLAR\n");
  writeFileSync(path.join(project, ".github", "agents", "reader.agent.md"), '---\ntools: ["read"]\n---\nRead.\n');
  writeFileSync(path.join(project, ".claude", "agents", "worker.md"), "---\nname: worker\n---\nWork.\n");
  const record = path.join(root, "record.json");
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    [
      "data_dir: ../data",
      `allowed_project_roots: ["${root}"]`,
      "claude:",
      `  binary: "${fakeClaude}"`,
      '  env_passthrough: ["FAKE_COPILOT_*"]',
      "copilot:",
      `  binary: "${fakeCopilot}"`,
      "",
    ].join("\n"),
  );
  for (const [id, markdown] of Object.entries(agents))
    writeFileSync(path.join(configDir, "agents", `${id}.md`), markdown);
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const claude = new ClaudeCodeExecutor({ binary: fakeClaude, strictMcpConfig: true, allowBypassPermissions: false });
  const copilot = new CopilotExecutor({ binary: config.copilot.binary });
  const repo = new RunRepository(db);
  const runs = new RunManager(config, repo, new HarnessRegistry([claude, copilot]));
  process.env.FAKE_COPILOT_RECORD = record;
  const cleanup = () => {
    delete process.env.FAKE_COPILOT_RECORD;
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  const recorded = () => JSON.parse(readFileSync(record, "utf8"));
  return { root, configDir, project: realpathSync(project), config, runs, repo, recorded, cleanup };
}

function parse(name) {
  const state = createCopilotState();
  const events = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .flatMap((l) => ingestCopilotLine(state, l));
  return { state, events };
}

test("a Copilot link runs the project's .github/agents file with --agent alone, under the envelope's rules", async () => {
  const t = setup({
    "pim-link":
      '---\nharness: copilot\nproject_agent: pim\npermission_mode: dontAsk\nallowed_tools: ["shell(ls)"]\n---\n',
  });
  try {
    const agent = t.config.agents.get("pim-link");
    assert.equal(agent.claudeAgent, "pim", "project_agent loads into the link field");
    const started = await t.runs.startRun({ agentId: "pim-link", projectPath: t.project, prompt: "fixture:link" });
    const run = await t.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "completed", run.error ?? "");
    assert.equal(run.harness, "copilot");
    const rec = t.recorded();
    const at = rec.argv.indexOf("--agent");
    assert.equal(rec.argv[at + 1], "pim");
    assert.ok(!rec.argv.includes("--add-dir"), "the project is the working directory: no --add-dir");
    assert.deepEqual(
      rec.argv.flatMap((a, i) => (a === "--allow-tool" ? [rec.argv[i + 1]] : [])),
      ["shell(ls)"],
      "the envelope's rules, nothing the agent file declares",
    );
    assert.match(rec.persona, /MEDLAR/, "the project's own agent file is what runs");
    assert.equal(
      run.projectAgentHash,
      projectAgentDefinitionHash(t.project, "pim", COPILOT_PROJECT_AGENTS),
      "the persona hash is the .github/agents file's",
    );
    assert.match(run.projectAgentHash, /^[0-9a-f]{12}$/);
  } finally {
    t.cleanup();
  }
});

test("a missing Copilot project agent is refused before the run row exists, with the available names", async () => {
  const t = setup({ nope: "---\nharness: copilot\nproject_agent: nope\npermission_mode: dontAsk\n---\n" });
  try {
    await assert.rejects(
      t.runs.startRun({ agentId: "nope", projectPath: t.project, prompt: "fixture:link" }),
      /agent "nope": runs as project agent "nope", but .*\.github\/agents has pim, reader/,
    );
    assert.deepEqual(t.repo.list(), [], "no run row was written");
  } finally {
    t.cleanup();
  }
});

test("a Copilot link with a body is refused at run start, the field named, never run without it", async () => {
  const t = setup({ bodied: "---\nharness: copilot\nproject_agent: pim\npermission_mode: dontAsk\n---\nAlso do X.\n" });
  try {
    await assert.rejects(
      t.runs.startRun({ agentId: "bodied", projectPath: t.project, prompt: "fixture:link" }),
      /system_prompt \(the agent file's body\) is not supported next to project_agent by harness copilot/,
    );
    assert.deepEqual(t.repo.list(), []);
  } finally {
    t.cleanup();
  }
});

test("the unknown-agent stderr of the double matches the real CLI's", () => {
  assert.match(readFileSync(path.join(fixtures, "link-unknown.stderr"), "utf8"), /^No such agent: nope, available: /);
});

test("parser: the agent file's model is taken from session.model_change when --model is not passed", () => {
  const linked = parse("link-model");
  const init = linked.events.find((e) => e.type === "init");
  assert.equal(init.model, "claude-haiku-4.5", "the agent change, not the account default");
  assert.equal(linked.state.model, "claude-haiku-4.5");
  assert.equal(parse("link-model-flag").state.model, "claude-haiku-4.5", "--model wins over the file's");
});

test("claude_agent and project_agent give the same definition and the same hash; both set is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-alias-"));
  try {
    const project = path.join(root, "project");
    mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(project, ".claude", "agents", "worker.md"), "---\nname: worker\n---\nWork.\n");
    const dirOld = path.join(root, "old");
    const dirNew = path.join(root, "new");
    mkdirSync(dirOld);
    mkdirSync(dirNew);
    writeFileSync(path.join(dirOld, "w.md"), "---\nclaude_agent: worker\npermission_mode: dontAsk\n---\n");
    writeFileSync(path.join(dirNew, "w.md"), "---\nproject_agent: worker\npermission_mode: dontAsk\n---\n");
    const old = loadAgentDir(dirOld, "user").agents.get("w");
    const neu = loadAgentDir(dirNew, "user").agents.get("w");
    const { sourcePath: _a, ...oldDef } = old;
    const { sourcePath: _b, ...newDef } = neu;
    assert.deepEqual(newDef, oldDef);
    assert.equal(agentDefinitionHash(neu, project), agentDefinitionHash(old, project));

    const both = path.join(root, "both");
    mkdirSync(both);
    writeFileSync(path.join(both, "w.md"), "---\nclaude_agent: worker\nproject_agent: worker\n---\n");
    const loaded = loadAgentDir(both, "user");
    assert.equal(loaded.agents.has("w"), false);
    assert.match(loaded.skipped[0].error, /set project_agent or claude_agent, not both/);

    assert.equal(agentSpecSchema.parse({ id: "w", project_agent: "worker" }).claude_agent, "worker");
    assert.throws(
      () => agentSpecSchema.parse({ id: "w", project_agent: "worker", claude_agent: "worker" }),
      /not both/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project agents of both harnesses are listed from their own folders; Copilot tools: use Copilot's names", () => {
  const t = setup({});
  try {
    assert.deepEqual(
      listProjectAgents(t.project, COPILOT_PROJECT_AGENTS).map((a) => a.name),
      ["pim", "reader"],
    );
    assert.deepEqual(
      listProjectAgents(t.project, CLAUDE_PROJECT_AGENTS).map((a) => a.name),
      ["worker"],
    );
    const reader = { tools: ["read"], frontmatterError: null };
    assert.deepEqual(linkToolGaps(["shell(ls)", "read"], reader, COPILOT_PROJECT_AGENTS).missing, ["shell(ls)"]);
    const tooly = { tools: ["execute", "read", "edit", "search"], frontmatterError: null };
    assert.deepEqual(
      linkToolGaps(["shell(ls)", "write", "url(github.com)"], tooly, COPILOT_PROJECT_AGENTS).missing,
      [],
    );
  } finally {
    t.cleanup();
  }
});
