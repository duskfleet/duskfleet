/**
 * Config loader: agent overrides, project registry merge, kind validation and what a
 * malformed agent file does to a reload. Each test builds its own config dir under tmp.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agentToSpec,
  assertAgentIdFree,
  assertAgentKind,
  assertAgentSpecClean,
  createAgentFromFields,
  deleteAgentFileAt,
  deleteSkippedUserAgentFiles,
  guessAgentId,
  loadAgentDir,
  loadAgents,
  loadConfig,
  RunManager,
  skippedAgentError,
  skippedUserAgentFiles,
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

test("scheduler.auto_pause: missing = true, a boolean is kept, anything else is refused", () => {
  const { configDir } = makeConfig();
  assert.equal(loadConfig(configDir).scheduler.autoPause, true);
  writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\nscheduler:\n  auto_pause: false\n");
  const off = loadConfig(configDir).scheduler;
  assert.equal(off.autoPause, false);
  assert.equal(off.autoPauseAfter, 5, "the threshold keeps its default while off");
  writeFileSync(path.join(configDir, "duskfleet.yaml"), 'data_dir: ../data\nscheduler:\n  auto_pause: "no"\n');
  assert.throws(() => loadConfig(configDir), /auto_pause/);
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

test("a malformed agent file is skipped by name, the other agents load", () => {
  const { configDir, dataDir } = makeConfig({ agents: { good: agentFile("fine") } });
  const bad = path.join(dataDir, "agents", "bad.md");
  writeFileSync(bad, "---\npermission_mode: not-a-mode\n---\nbody\n");
  const config = loadConfig(configDir);
  assert.deepEqual([...config.agents.keys()], ["good"]);
  assert.equal(config.skippedAgents.length, 1);
  const [s] = config.skippedAgents;
  assert.equal(s.sourcePath, bad);
  assert.equal(s.id, "bad");
  assert.equal(s.source, "user");
  assert.match(s.error, /permission_mode/);
  assert.match(skippedAgentError(config, "bad"), /agent "bad" is unavailable: its file .*bad\.md does not load/);
  assert.equal(skippedAgentError(config, "good"), null);

  rmSync(bad);
  assert.deepEqual(loadConfig(configDir).skippedAgents, [], "a fixed file loads again");
});

test("unreadable YAML, a duplicate id and an unknown project each skip one file only", () => {
  const { configDir, dataDir } = makeConfig({
    userAgents: {
      a: agentFile("first", "id: same\n"),
      b: agentFile("second", "id: same\n"),
      broken: "---\ndescription: [unclosed\n---\nbody\n",
      bound: agentFile("bound", "project: nowhere\n"),
      ok: agentFile("ok"),
    },
  });
  const config = loadConfig(configDir);
  assert.deepEqual([...config.agents.keys()].sort(), ["ok", "same"]);
  assert.equal(config.agents.get("same").description, "first", "the first file of a duplicate id stays");
  const byPath = new Map(config.skippedAgents.map((s) => [path.basename(s.sourcePath), s]));
  assert.deepEqual([...byPath.keys()].sort(), ["b.md", "bound.md", "broken.md"]);
  assert.match(byPath.get("b.md").error, /Duplicate agent id "same"/);
  assert.equal(byPath.get("broken.md").id, "broken", "unreadable frontmatter: the file name is the id");
  assert.match(byPath.get("bound.md").error, /project "nowhere" is not in projects.yaml/);
  assert.ok(byPath.get("bound.md").sourcePath.startsWith(path.join(dataDir, "agents")));
});

test("a broken user agent never falls back to the builtin of the same id", () => {
  const { configDir } = makeConfig({
    agents: { helper: agentFile("builtin helper"), other: agentFile("other") },
    userAgents: { helper: "---\nid: helper\nmodel: 3\n---\nbody\n", bound: agentFile("b", "project: gone\n") },
  });
  writeFileSync(path.join(configDir, "agents", "bound.md"), agentFile("builtin bound"));
  const config = loadConfig(configDir);
  assert.deepEqual([...config.agents.keys()], ["other"], "neither builtin is served in place of the broken file");
  assert.match(skippedAgentError(config, "helper"), /data\/agents\/helper\.md does not load/);
  assert.match(skippedAgentError(config, "bound"), /project "gone"/);
});

test("default_agent naming a skipped agent loads; a run without agent_id fails naming the file", async () => {
  const { configDir, dataDir } = makeConfig({
    userAgents: { main: "---\nmodel: 3\n---\nbody\n", ok: agentFile("ok") },
  });
  writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\ndefault_agent: main\n");
  const config = loadConfig(configDir);
  assert.equal(config.defaultAgent, "main");
  const runs = new RunManager(config, null, null, { owner: "test@host:1" });
  await assert.rejects(
    runs.startRun({ prompt: "x", projectPath: dataDir }),
    (err) => err.message.includes(path.join(dataDir, "agents", "main.md")) && /unavailable/.test(err.message),
  );
  writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\ndefault_agent: ghost\n");
  assert.throws(() => loadConfig(configDir), /default_agent "ghost" not found/, "an unknown default still fails");
});

test("an invalid duskfleet.yaml still fails the load, and a reload keeps the previous config", () => {
  const { configDir } = makeConfig({ agents: { good: agentFile("fine") } });
  const config = loadConfig(configDir);
  const runs = new RunManager(config, null, null, { owner: "test@host:1" });

  writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\nmax_concurrent_runs: lots\n");
  assert.throws(() => loadConfig(configDir), /max_concurrent_runs/);
  const reloaded = runs.reloadConfig();
  assert.equal(reloaded, config, "the previous config object is kept");
  assert.match(runs.configReloadError, /max_concurrent_runs/, "the failed reload is recorded");

  writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\n");
  assert.deepEqual([...runs.reloadConfig().agents.keys()], ["good"]);
  assert.equal(runs.configReloadError, null, "a successful reload clears it");
});

test("create still removes a file that does not load, and says why", () => {
  // other.md declares id x: the new x.md sorts after it, so the loader skips x.md as a duplicate.
  const { configDir, dataDir } = makeConfig({ userAgents: { other: agentFile("taken", "id: x\n") } });
  const config = loadConfig(configDir);
  const runs = new RunManager(config, null, null, { owner: "test@host:1" });
  assert.throws(
    () => createAgentFromFields("own", { id: "x", system_prompt: "Hi." }, config, () => runs.reloadConfig()),
    /x\.md did not load \(Duplicate agent id "x".*\); it has been removed again/,
  );
  assert.equal(existsSync(path.join(dataDir, "agents", "x.md")), false, "rolled back");
  assert.equal(loadConfig(configDir).agents.get("x").description, "taken");
});

test("unparseable YAML: the id line is the guess, so the builtin it overrides is not served", () => {
  const { configDir } = makeConfig({
    agents: { reviewer: agentFile("builtin reviewer"), "my-reviewer": agentFile("builtin named like the file") },
    userAgents: { "my-reviewer": "---\nid: reviewer\ndescription: [unclosed\n---\nbody\n" },
  });
  const config = loadConfig(configDir);
  assert.equal(config.skippedAgents[0].id, "reviewer", "the declared id, read from the raw text");
  assert.equal(config.agents.has("reviewer"), false, "no fallback to the builtin reviewer");
  assert.equal(config.agents.get("my-reviewer").source, "builtin", "the builtin named like the file is untouched");
  assert.equal(guessAgentId("---\nid: 'abc'  # x\nmodel: [\n---\n"), "abc");
  assert.equal(guessAgentId("---\n  id: nested\n---\n"), null, "only a top-level id line");
  assert.equal(guessAgentId("no frontmatter"), null);
});

test("create refuses the id of a user file that does not load, unless overwrite is set", () => {
  const { configDir, dataDir } = makeConfig({
    agents: { helper: agentFile("builtin helper") },
    userAgents: { "hand-edited": "---\nid: helper\nmodel: 3\n---\nbody\n" },
  });
  const config = loadConfig(configDir);
  const broken = path.join(dataDir, "agents", "hand-edited.md");
  assert.throws(
    () => assertAgentIdFree(config, "helper", false, "overwrite: true", "update_agent"),
    (err) =>
      err.message.includes(broken) && /does not load .*model/.test(err.message) && /overwrite: true/.test(err.message),
  );
  assert.doesNotThrow(() => assertAgentIdFree(config, "helper", true, "overwrite: true", "update_agent"));
  assert.deepEqual(
    skippedUserAgentFiles(config, "helper").map((s) => s.sourcePath),
    [broken],
  );
  assert.deepEqual(deleteSkippedUserAgentFiles(config, "helper"), [broken], "deleted by path, not by id");
  assert.equal(existsSync(broken), false);
  assert.equal(loadConfig(configDir).agents.get("helper").source, "builtin", "the builtin is active again");
});

test("a broken builtin does not affect skippedUserAgentFiles, and deleteAgentFileAt stays in its directory", () => {
  const { configDir, dataDir } = makeConfig({ agents: { bad: "---\nmodel: 3\n---\nbody\n" } });
  const config = loadConfig(configDir);
  assert.deepEqual(skippedUserAgentFiles(config, "bad"), [], "builtin files are never deleted by tools");
  assert.throws(
    () => deleteAgentFileAt(path.join(dataDir, "agents"), path.join(configDir, "agents", "bad.md")),
    /not an agent file/,
  );
  assert.equal(loadAgentDir(path.join(configDir, "agents"), "builtin").agents.size, 0, "lenient read, no throw");
});

test("loadAgents (strict) still throws on the first file that does not load", () => {
  const { configDir } = makeConfig({ agents: { bad: "---\npermission_mode: nope\n---\nbody\n" } });
  assert.throws(() => loadAgents(path.join(configDir, "agents"), "builtin"), /invalid agent file .*bad\.md/);
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
