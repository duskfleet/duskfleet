/**
 * Issue #459: a link may leave `description` and `model` out; readers (list_agents, the CLI's
 * `agents`, doctor) fall back to the project agent's, at read time only. The loaded definition and
 * its hash never change.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentDefinitionHash, effectiveAgentFields, linkProjectPath } from "@duskfleet/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { linkModelOverrides, renderDoctor } from "../dist/render/index.js";
import { testEnv } from "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

/** A project folder with `.claude/agents/<name>.md` files (name -> full Markdown). */
function projectWith(files) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-link-effective-"));
  const dir = path.join(root, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [name, md] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.md`), md);
  return root;
}

const PERSONA = "---\nname: worker\ndescription: Works the queue.\nmodel: sonnet\n---\nYou work.\n";

test("effectiveAgentFields: a link that sets neither lists the project agent's description and model", () => {
  const project = projectWith({ worker: PERSONA });
  try {
    const e = effectiveAgentFields({ description: "", claudeAgent: "worker" }, project);
    assert.equal(e.description, "Works the queue.");
    assert.equal(e.descriptionSource, "project agent");
    assert.equal(e.model, "sonnet");
    assert.equal(e.modelSource, "project agent");
    assert.equal(e.projectAgentModel, "sonnet");
    // A whitespace-only description counts as empty.
    assert.equal(
      effectiveAgentFields({ description: "  ", claudeAgent: "worker" }, project).descriptionSource,
      "project agent",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("effectiveAgentFields: a link that sets both keeps its own values", () => {
  const project = projectWith({ worker: PERSONA });
  try {
    const e = effectiveAgentFields({ description: "Mine.", model: "haiku", claudeAgent: "worker" }, project);
    assert.deepEqual(e, {
      description: "Mine.",
      descriptionSource: "agent",
      model: "haiku",
      modelSource: "agent",
      projectAgentModel: "sonnet",
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("effectiveAgentFields: only one set, the other falls back", () => {
  const project = projectWith({ worker: PERSONA });
  try {
    const ownDesc = effectiveAgentFields({ description: "Mine.", claudeAgent: "worker" }, project);
    assert.equal(ownDesc.descriptionSource, "agent");
    assert.equal(ownDesc.model, "sonnet");
    assert.equal(ownDesc.modelSource, "project agent");
    const ownModel = effectiveAgentFields({ description: "", model: "haiku", claudeAgent: "worker" }, project);
    assert.equal(ownModel.description, "Works the queue.");
    assert.equal(ownModel.descriptionSource, "project agent");
    assert.equal(ownModel.model, "haiku");
    assert.equal(ownModel.modelSource, "agent");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("effectiveAgentFields: neither file has them, unparsable frontmatter, own agents, unknown project", () => {
  const project = projectWith({
    bare: "---\nname: bare\n---\nNo description, no model.\n",
    broken: "---\nname: [unclosed\nmodel: opus\n---\nBody.\n",
  });
  try {
    const none = effectiveAgentFields({ description: "", claudeAgent: "bare" }, project);
    assert.deepEqual(none, {
      description: "",
      descriptionSource: null,
      model: null,
      modelSource: null,
      projectAgentModel: null,
    });
    // Unparsable frontmatter: still matched by file name, contributes nothing.
    const broken = effectiveAgentFields({ description: "", claudeAgent: "broken" }, project);
    assert.equal(broken.model, null);
    assert.equal(broken.descriptionSource, null);
    // An own agent never reads a project agent, even with a path.
    const own = effectiveAgentFields({ description: "", model: undefined }, project);
    assert.equal(own.model, null);
    assert.equal(own.projectAgentModel, null);
    // A link whose project path is unknown keeps its own values.
    assert.equal(effectiveAgentFields({ description: "", claudeAgent: "bare" }, null).modelSource, null);
    // A link to a name the project does not define.
    assert.equal(effectiveAgentFields({ description: "", claudeAgent: "ghost" }, project).model, null);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("effectiveAgentFields: an unreadable project folder contributes nothing instead of throwing", () => {
  // A directory named x.md inside .claude/agents (readFileSync would throw EISDIR).
  const withDir = projectWith({ worker: PERSONA });
  // .claude/agents is a plain file (readdirSync would throw ENOTDIR).
  const withFile = mkdtempSync(path.join(tmpdir(), "duskfleet-link-effective-"));
  try {
    mkdirSync(path.join(withDir, ".claude", "agents", "x.md"));
    mkdirSync(path.join(withFile, ".claude"), { recursive: true });
    writeFileSync(path.join(withFile, ".claude", "agents"), "not a folder");
    for (const project of [withDir, withFile]) {
      assert.deepEqual(effectiveAgentFields({ description: "", model: "haiku", claudeAgent: "worker" }, project), {
        description: "",
        descriptionSource: null,
        model: "haiku",
        modelSource: "agent",
        projectAgentModel: null,
      });
    }
    const projects = new Map([["app", { path: withDir }]]);
    assert.deepEqual(
      linkModelOverrides(
        [{ id: "cheap", description: "", model: "haiku", claudeAgent: "worker", project: "app" }],
        projects,
      ),
      [],
    );
  } finally {
    rmSync(withDir, { recursive: true, force: true });
    rmSync(withFile, { recursive: true, force: true });
  }
});

test("effectiveAgentFields: a project agent with model: inherit has no model of its own", () => {
  const project = projectWith({ worker: "---\nname: worker\ndescription: Works.\nmodel: inherit\n---\nYou work.\n" });
  try {
    const bare = effectiveAgentFields({ description: "", claudeAgent: "worker" }, project);
    assert.equal(bare.model, null);
    assert.equal(bare.modelSource, null);
    assert.equal(bare.projectAgentModel, null);
    const own = effectiveAgentFields({ description: "", model: "haiku", claudeAgent: "worker" }, project);
    assert.equal(own.model, "haiku");
    assert.equal(own.modelSource, "agent");
    assert.equal(own.projectAgentModel, null);
    // No false doctor advice: inherit cannot disagree with the link's model.
    const projects = new Map([["app", { path: project }]]);
    assert.deepEqual(
      linkModelOverrides(
        [{ id: "cheap", description: "", model: "haiku", claudeAgent: "worker", project: "app" }],
        projects,
      ),
      [],
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("linkProjectPath resolves a bound link only", () => {
  const projects = new Map([["app", { path: "/p/app" }]]);
  assert.equal(linkProjectPath({ claudeAgent: "w", project: "app" }, projects), "/p/app");
  assert.equal(linkProjectPath({ claudeAgent: "w", project: "gone" }, projects), null);
  assert.equal(linkProjectPath({ project: "app" }, projects), null);
});

test("the fallback never touches the definition: same agent hash before and after", () => {
  const project = projectWith({ worker: PERSONA });
  try {
    const agent = {
      id: "w",
      name: "w",
      description: "",
      permissionMode: "acceptEdits",
      systemPrompt: "",
      claudeAgent: "worker",
      project: "app",
      source: "user",
      sourcePath: "/x/w.md",
    };
    const before = agentDefinitionHash(agent, project);
    const copy = structuredClone(agent);
    effectiveAgentFields(agent, project);
    assert.deepEqual(agent, copy);
    assert.equal(agentDefinitionHash(agent, project), before);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("doctor: one advice line for a link whose own model differs from the project agent's", () => {
  const project = projectWith({ worker: PERSONA });
  try {
    const projects = new Map([["app", { path: project }]]);
    const overrides = linkModelOverrides(
      [
        { id: "cheap", description: "", model: "haiku", claudeAgent: "worker", project: "app" },
        { id: "same", description: "", model: "sonnet", claudeAgent: "worker", project: "app" },
        { id: "inherits", description: "", claudeAgent: "worker", project: "app" },
        { id: "own", description: "", model: "opus" },
      ],
      projects,
    );
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].agentId, "cheap");
    assert.match(overrides[0].advice, /sets model: haiku, its project agent worker says sonnet: runs use haiku/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("doctor renders the link model advice under the agents check", () => {
  const lines = renderDoctor(
    {
      node: "v24.0.0",
      claudeBinary: "claude",
      claudeVersion: "2.0.0",
      path: "/usr/bin",
      pathDefaulted: false,
      error: null,
      configDir: "/c",
      configSource: "env",
      configLookup: { env: "/c", repo: null, user: "/u" },
      dataDir: "/d",
      dataSource: "config",
      agents: ["cheap"],
      linkModelOverrides: [
        {
          agentId: "cheap",
          claudeAgent: "worker",
          model: "haiku",
          projectAgentModel: "sonnet",
          advice:
            "link cheap sets model: haiku, its project agent worker says sonnet: runs use haiku (the Duskfleet value wins)",
        },
      ],
      scheduler: {
        enabled: true,
        ticking: false,
        holder: null,
        service: { supported: false, installed: false, running: null, detail: "" },
        keepAwake: null,
        advice: null,
        duplicateSchedules: [],
      },
      unpricedRuns: [],
      orphans: { recovered: [], advice: null },
    },
    { color: false, width: 200 },
  ).join("\n");
  assert.match(lines, /agents\s+1: cheap\n\s+link cheap sets model: haiku/);
});

test("list_agents shows a link's project agent description and model, with where each came from", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-link-list-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = projectWith({ worker: PERSONA });
  writeFileSync(path.join(configDir, "duskfleet.yaml"), `data_dir: ../data\nclaude:\n  binary: "${fakeBinary}"\n`);
  writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  app:\n    path: ${project}\n`);
  writeFileSync(
    path.join(configDir, "agents", "bare-link.md"),
    "---\nclaude_agent: worker\nproject: app\npermission_mode: dontAsk\n---\n",
  );
  writeFileSync(
    path.join(configDir, "agents", "full-link.md"),
    "---\ndescription: My envelope.\nmodel: haiku\nclaude_agent: worker\nproject: app\n---\n",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    assert.equal(result.isError ?? false, false, result.content?.[0]?.text);
    const agents = JSON.parse(result.content[0].text).agents;
    const bare = agents.find((a) => a.id === "bare-link");
    assert.equal(bare.description, "Works the queue.");
    assert.equal(bare.descriptionSource, "project agent");
    assert.equal(bare.model, "sonnet");
    assert.equal(bare.modelSource, "project agent");
    const full = agents.find((a) => a.id === "full-link");
    assert.equal(full.description, "My envelope.");
    assert.equal(full.descriptionSource, "agent");
    assert.equal(full.model, "haiku");
    assert.equal(full.modelSource, "agent");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
