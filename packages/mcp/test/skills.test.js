/**
 * `skills:` in agent frontmatter (#48): names resolved in data/skills then config/skills, checked
 * on create / update (never on load), delivered as a content-addressed bundle under
 * data/skill-bundles/ passed with --add-dir (fake-claude.js "add-dirs" echoes what it got), the
 * bundle id stored on the run, and notes for a skill gone since or shadowed by the project.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import {
  agentToSpec,
  assertSkillsAvailable,
  ClaudeCodeExecutor,
  createAgentFromFields,
  loadConfig,
  openDatabase,
  prepareSkillBundle,
  RunManager,
  RunRepository,
  renderAgentMarkdown,
  resolveSkill,
  summarizeRun,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

function writeSkill(base, name, body = `---\nname: ${name}\ndescription: test skill\n---\nSay hi.\n`) {
  mkdirSync(path.join(base, name), { recursive: true });
  writeFileSync(path.join(base, name, "SKILL.md"), body);
}

function makeRoot() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-skills-")));
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const project = path.join(root, "project");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.5\n`,
  );
  writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  demo:\n    path: ${project}\n`);
  return {
    root,
    configDir,
    dataDir,
    project,
    builtinSkills: path.join(configDir, "skills"),
    userSkills: path.join(dataDir, "skills"),
  };
}

test("the loader reads skills: names, and refuses a name that is not a folder name", () => {
  const r = makeRoot();
  try {
    writeFileSync(path.join(r.configDir, "agents", "a.md"), `---\nskills: [greet, review-pr]\n---\nHi.\n`);
    const agent = loadConfig(r.configDir).agents.get("a");
    assert.deepEqual(agent.skills, ["greet", "review-pr"]);
    assert.deepEqual(agentToSpec(agent).skills, ["greet", "review-pr"]);
    assert.match(renderAgentMarkdown(agentToSpec(agent)), /skills:\n {2}- greet\n {2}- review-pr/);
    // A missing skill does not break the load: existence is a create / update check.
    writeFileSync(path.join(r.configDir, "agents", "b.md"), `---\nskills: ["../etc"]\n---\nHi.\n`);
    assert.throws(() => loadConfig(r.configDir), /skill names are lowercase letters/);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("resolveSkill: data/skills wins over config/skills; a folder without SKILL.md is no skill", () => {
  const r = makeRoot();
  try {
    writeSkill(r.builtinSkills, "greet");
    writeSkill(r.builtinSkills, "shared");
    writeSkill(r.userSkills, "shared");
    mkdirSync(path.join(r.userSkills, "empty"), { recursive: true });
    const config = loadConfig(r.configDir);
    assert.equal(resolveSkill(config, "greet").source, "builtin");
    assert.equal(resolveSkill(config, "shared").source, "user");
    assert.equal(resolveSkill(config, "shared").dir, path.join(r.userSkills, "shared"));
    assert.equal(resolveSkill(config, "empty"), null);
    assert.equal(resolveSkill(config, "../config"), null);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("create refuses an unknown skill and a skill file with a home path; nothing is written", () => {
  const r = makeRoot();
  try {
    writeSkill(r.builtinSkills, "greet");
    const config = loadConfig(r.configDir);
    const reload = () => loadConfig(r.configDir);
    const agentFile = path.join(config.userAgentsDir, "s.md");
    assert.throws(
      () => createAgentFromFields("own", { id: "s", system_prompt: "Hi.", skills: ["greet", "nope"] }, config, reload),
      /unknown skill "nope"/,
    );
    assert.equal(existsSync(agentFile), false);

    // Built at runtime so check:public does not flag this file.
    const home = ["", "Users", "someone"].join("/");
    writeSkill(r.builtinSkills, "leaky", `---\nname: leaky\n---\nRead ${home}/notes first.\n`);
    assert.throws(
      () => createAgentFromFields("own", { id: "s", system_prompt: "Hi.", skills: ["leaky"] }, config, reload),
      /skills\/leaky\/SKILL\.md: macOS home path/,
    );
    assert.equal(existsSync(agentFile), false);
    assert.throws(() => assertSkillsAvailable(["leaky"], config, "/nowhere"), /macOS home path/);

    const agent = createAgentFromFields("own", { id: "s", system_prompt: "Hi.", skills: ["greet"] }, config, reload);
    assert.deepEqual(agent.skills, ["greet"]);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("prepareSkillBundle: content-addressed, reused while unchanged, new id after an edit", () => {
  const r = makeRoot();
  try {
    writeSkill(r.builtinSkills, "greet");
    writeSkill(r.userSkills, "lint");
    const config = loadConfig(r.configDir);
    const a = prepareSkillBundle(config, ["lint", "greet", "lint"]);
    assert.match(a.id, /^[0-9a-f]{16}$/);
    assert.equal(a.dir, path.join(r.dataDir, "skill-bundles", a.id));
    assert.deepEqual(
      a.skills.map((s) => s.name),
      ["greet", "lint"],
    );
    assert.ok(existsSync(path.join(a.dir, ".claude", "skills", "greet", "SKILL.md")));
    assert.ok(existsSync(path.join(a.dir, ".claude", "skills", "lint", "SKILL.md")));
    assert.equal(prepareSkillBundle(config, ["greet", "lint"]).id, a.id, "order and duplicates do not matter");
    // A removed bundle is rebuilt under the same id.
    rmSync(a.dir, { recursive: true, force: true });
    assert.equal(prepareSkillBundle(config, ["greet", "lint"]).id, a.id);
    assert.ok(existsSync(path.join(a.dir, ".claude", "skills", "greet", "SKILL.md")));

    writeFileSync(path.join(r.builtinSkills, "greet", "extra.md"), "More.\n");
    const b = prepareSkillBundle(config, ["greet", "lint"]);
    assert.notEqual(b.id, a.id, "an edited skill is a new bundle");
    assert.deepEqual(
      readdirSync(path.join(r.dataDir, "skill-bundles")).filter((d) => d.startsWith(".")),
      [],
      "no temporary directory left behind",
    );

    const partial = prepareSkillBundle(config, ["greet", "gone"]);
    assert.deepEqual(partial.missing, ["gone"]);
    assert.equal(prepareSkillBundle(config, ["gone"]), null);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("a run gets the bundle with --add-dir, stores its id, and never writes the project", async () => {
  const r = makeRoot();
  writeSkill(r.builtinSkills, "greet");
  writeSkill(r.builtinSkills, "shadowed");
  mkdirSync(path.join(r.project, ".claude", "skills", "shadowed"), { recursive: true });
  writeFileSync(
    path.join(r.configDir, "agents", "skilled.md"),
    `---\nproject: demo\nadd_dirs: ["${r.root}/extra"]\nskills: [greet, shadowed, gone]\n---\nHi.\n`,
  );
  writeFileSync(path.join(r.configDir, "agents", "plain.md"), `---\nproject: demo\n---\nHi.\n`);
  mkdirSync(path.join(r.root, "extra"));
  const config = loadConfig(r.configDir);
  const db = openDatabase(config.dataDir);
  const runs = new RunManager(
    config,
    new RunRepository(db),
    new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true, allowBypassPermissions: false }),
  );
  try {
    const run = await runs.waitForRun((await runs.startRun({ prompt: "add-dirs", agentId: "skilled" })).id, 10_000);
    assert.equal(run.status, "completed");
    assert.match(run.skillsBundle, /^[0-9a-f]{16}$/);
    const bundleDir = path.join(r.dataDir, "skill-bundles", run.skillsBundle);
    assert.equal(run.resultText, `add-dirs ${JSON.stringify([path.join(r.root, "extra"), bundleDir])}`);
    assert.ok(existsSync(path.join(bundleDir, ".claude", "skills", "greet", "SKILL.md")));
    assert.equal(summarizeRun(run).skillsBundle, run.skillsBundle);
    assert.deepEqual(readdirSync(path.join(r.project, ".claude", "skills")), ["shadowed"], "project untouched");

    const notes = runs
      .events(run.id)
      .filter((e) => e.type === "note")
      .map((e) => e.payload.message);
    assert.ok(notes.some((m) => /skills greet, shadowed available from bundle/.test(m)));
    assert.ok(notes.some((m) => /skill gone not found/.test(m)));
    assert.ok(notes.some((m) => /project defines \.claude\/skills\/ shadowed too/.test(m)));

    const plain = await runs.waitForRun((await runs.startRun({ prompt: "add-dirs", agentId: "plain" })).id, 10_000);
    assert.equal(plain.skillsBundle, null);
    assert.equal(plain.resultText, "add-dirs []");
  } finally {
    runs.shutdown();
    await new Promise((res) => setTimeout(res, 200));
    db.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});
