/**
 * Config loader: agent overrides, project registry merge, kind validation and what a
 * malformed agent file does to a reload. Each test builds its own config dir under tmp.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agentToSpec,
  assertAgentKind,
  assertAgentSpecClean,
  loadAgents,
  loadConfig,
  RunManager,
} from "@duskfleet/core";

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A config dir (`<root>/config`) with its data dir next to it, as in the repo. */
function makeConfig({ agents = {}, userAgents = {}, projects = null, userProjects = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "df-core-loader-"));
  roots.push(root);
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  mkdirSync(path.join(dataDir, "agents"), { recursive: true });
  writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\n");
  for (const [id, text] of Object.entries(agents)) writeFileSync(path.join(configDir, "agents", `${id}.md`), text);
  for (const [id, text] of Object.entries(userAgents)) writeFileSync(path.join(dataDir, "agents", `${id}.md`), text);
  if (projects) writeFileSync(path.join(configDir, "projects.yaml"), projects);
  if (userProjects) writeFileSync(path.join(dataDir, "projects.yaml"), userProjects);
  return { root, configDir, dataDir };
}

const agentFile = (description, extra = "") => `---\ndescription: ${description}\n${extra}---\nYou are a test agent.\n`;

test("a user agent in data/agents overrides the builtin with the same id", () => {
  const { configDir } = makeConfig({
    agents: { helper: agentFile("builtin helper"), other: agentFile("builtin other") },
    userAgents: { helper: agentFile("user helper", "model: haiku\n") },
  });
  const config = loadConfig(configDir);
  const helper = config.agents.get("helper");
  assert.equal(helper.source, "user");
  assert.equal(helper.description, "user helper");
  assert.equal(helper.model, "haiku");
  assert.equal(config.agents.get("other").source, "builtin", "untouched builtins stay");
});

test("data/projects.yaml merges over config/projects.yaml, same id = the private entry wins", () => {
  const { root, configDir } = makeConfig({
    projects: "projects:\n  shared:\n    path: ../shared-public\n  public-only:\n    path: ../pub\n",
    userProjects:
      "projects:\n  shared:\n    path: ../shared-private\n    inherit_mcp: true\n  private-only:\n    path: ../priv\n",
  });
  const { projects } = loadConfig(configDir);
  assert.deepEqual([...projects.keys()].sort(), ["private-only", "public-only", "shared"]);
  assert.equal(projects.get("public-only").path, path.join(root, "pub"), "relative to config/");
  assert.equal(projects.get("shared").path, path.join(root, "shared-private"), "relative to data/, private wins");
  assert.equal(projects.get("shared").inheritMcp, true);
  assert.equal(projects.get("private-only").path, path.join(root, "priv"));
});

test("a malformed agent file fails loadConfig by name, and a reload keeps the previous config", () => {
  const { configDir, dataDir } = makeConfig({ agents: { good: agentFile("fine") } });
  const config = loadConfig(configDir);
  const runs = new RunManager(config, null, null, { owner: "test@host:1" });

  const bad = path.join(dataDir, "agents", "bad.md");
  writeFileSync(bad, "---\npermission_mode: not-a-mode\n---\nbody\n");
  assert.throws(
    () => loadConfig(configDir),
    (err) => err.message.includes(bad) && /permission_mode/.test(err.message),
  );

  const reloaded = runs.reloadConfig();
  assert.equal(reloaded, config, "the previous config object is kept");
  assert.deepEqual([...reloaded.agents.keys()], ["good"]);
  assert.match(runs.configReloadError, /permission_mode/, "the failed reload is recorded");

  rmSync(bad);
  writeFileSync(path.join(dataDir, "agents", "added.md"), agentFile("new"));
  assert.deepEqual([...runs.reloadConfig().agents.keys()].sort(), ["added", "good"], "a fixed file loads again");
  assert.equal(runs.configReloadError, null, "a successful reload clears it");
});

test("the builtin agents shipped in config/agents load, are general-purpose and fit for a public repo", () => {
  const builtinDir = fileURLToPath(new URL("../../../config/agents", import.meta.url));
  const agents = loadAgents(builtinDir, "builtin");
  for (const agent of agents.values()) {
    assert.equal(agent.project, undefined, `${agent.id}: builtins are not bound to a project`);
    assert.equal(agent.claudeAgent, undefined, `${agent.id}: builtins are own agents`);
    assert.ok(agent.model, `${agent.id}: builtins set a model (the CLI default can cost far more)`);
    assert.ok(agent.systemPrompt.length > 0, `${agent.id}: own agents need a prompt`);
    assert.doesNotThrow(() => assertAgentSpecClean(agentToSpec(agent)), agent.id);
  }

  const loop = agents.get("pr-check-loop");
  assert.ok(loop, "pr-check-loop ships as a builtin");
  for (const tool of ["Bash(gh pr checks:*)", "Bash(gh run view:*)", "Bash(gh run rerun:*)", "Bash(git push:*)"]) {
    assert.ok(loop.allowedTools.includes(tool), `pr-check-loop allow-lists ${tool}`);
  }
  assert.match(loop.systemPrompt, /at most 5 iterations/);
  assert.match(loop.systemPrompt, /--interval 30/);
});

test("assertAgentKind: own vs link combinations", () => {
  const { root } = makeConfig();
  const projectPath = path.join(root, "target");
  mkdirSync(path.join(projectPath, ".claude", "agents"), { recursive: true });
  writeFileSync(path.join(projectPath, ".claude", "agents", "builder.md"), "---\nname: builder\n---\nBuild.\n");
  const resolve = (id) => (id === "target" ? projectPath : null);

  assert.doesNotThrow(() => assertAgentKind("own", { system_prompt: "You are X." }, resolve));
  assert.throws(() => assertAgentKind("own", { system_prompt: "  " }, resolve), /needs a system_prompt/);
  assert.throws(
    () => assertAgentKind("own", { system_prompt: "x", claude_agent: "builder" }, resolve),
    /cannot have claude_agent/,
  );

  assert.doesNotThrow(() => assertAgentKind("link", { claude_agent: "builder", project: "target" }, resolve));
  assert.throws(() => assertAgentKind("link", { project: "target" }, resolve), /needs claude_agent/);
  assert.throws(() => assertAgentKind("link", { claude_agent: "builder" }, resolve), /needs the folder/);
  assert.throws(
    () => assertAgentKind("link", { claude_agent: "builder", project: "nowhere" }, resolve),
    /unknown project "nowhere"/,
  );
  assert.throws(
    () => assertAgentKind("link", { claude_agent: "ghost", project: "target" }, resolve),
    /defines no agent "ghost".*available: builder/,
  );
});
