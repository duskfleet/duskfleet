/**
 * Agent guidance follows the harness (issue #494): each harness names its own folder of project
 * agents, nothing served presents `.claude/agents/` without naming the claude harness, and a link
 * on a harness that cannot run one is refused with the way forward.
 */
import "./helpers.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  builtinHarnesses,
  CLAUDE_PROJECT_AGENTS,
  CODEX_PROJECT_AGENTS,
  COPILOT_PROJECT_AGENTS,
  harnessRefusal,
  listProjectAgents,
  projectAgentFolderOf,
} from "@duskfleet/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_INSTRUCTIONS } from "../dist/mcp/server.js";
import { buildToolCatalog } from "../dist/tools-catalog.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

/** Every `.claude/agents` in `text` is introduced as the claude harness's folder. */
function claudeFolderOnlyForClaude(text, where) {
  const bare = text.replaceAll("claude: .claude/agents", "").replaceAll("claude: \\.claude/agents", "");
  assert.doesNotMatch(bare, /\.claude\/agents/, `${where} names .claude/agents without the claude harness`);
}

test("each shipped harness names its own project-agent folder", () => {
  assert.equal(projectAgentFolderOf("claude", builtinHarnesses), CLAUDE_PROJECT_AGENTS);
  assert.equal(projectAgentFolderOf("copilot", builtinHarnesses).dir, ".github/agents");
  assert.equal(projectAgentFolderOf("codex", builtinHarnesses).dir, ".codex/agents");
});

test("the server instructions and the agent tool schemas tie .claude/agents to the claude harness", async () => {
  claudeFolderOnlyForClaude(SERVER_INSTRUCTIONS, "SERVER_INSTRUCTIONS");
  assert.match(SERVER_INSTRUCTIONS, /\.github\/agents/);
  assert.match(SERVER_INSTRUCTIONS, /\.codex\/agents/);
  const catalog = await buildToolCatalog();
  for (const name of ["create_agent", "update_agent", "list_project_agents"]) {
    const tool = catalog.tools.find((t) => t.name === name);
    assert.ok(tool, name);
    claudeFolderOnlyForClaude(JSON.stringify({ d: tool.description, s: tool.inputSchema }), name);
  }
});

test("a link on a harness without links is refused with the remedy and its own folder", () => {
  for (const [harness, folder] of [["codex", /\.codex\/agents/]]) {
    const why = harnessRefusal({ harness, claude_agent: "x", permission_mode: "acceptEdits" }, builtinHarnesses);
    assert.match(why, new RegExp(`^claude_agent is not supported by harness ${harness}`));
    assert.match(why, folder);
    assert.match(why, new RegExp(`kind "own" on harness ${harness}`));
    assert.match(why, /or harness: claude if the project defines a Claude Code agent in \.claude\/agents\//);
  }
  assert.equal(
    harnessRefusal({ claude_agent: "x", permission_mode: "acceptEdits" }, builtinHarnesses),
    null,
    "a Claude link still fits",
  );
  assert.equal(
    harnessRefusal({ harness: "copilot", claude_agent: "x", permission_mode: "acceptEdits" }, builtinHarnesses),
    null,
    "a Copilot link fits since #466",
  );
});

test("listProjectAgents reads the folder it is given: Copilot Markdown, Codex TOML by its name field", () => {
  const project = mkdtempSync(path.join(tmpdir(), "duskfleet-folders-"));
  try {
    mkdirSync(path.join(project, ".github", "agents"), { recursive: true });
    writeFileSync(
      path.join(project, ".github", "agents", "reviewer.agent.md"),
      "---\ndescription: Reviews\n---\nReview.\n",
    );
    writeFileSync(path.join(project, ".github", "agents", "notes.md"), "not an agent file\n");
    mkdirSync(path.join(project, ".codex", "agents"), { recursive: true });
    writeFileSync(
      path.join(project, ".codex", "agents", "file-name.toml"),
      'name = "planner"\ndescription = "Plans \\"well\\""\nmodel = \'gpt-5\'\ndeveloper_instructions = """\nPlan.\n"""\n\n[extra]\nname = "not this"\n',
    );
    writeFileSync(path.join(project, ".codex", "agents", "nameless.toml"), 'description = "no name"\n');
    assert.deepEqual(
      listProjectAgents(project, COPILOT_PROJECT_AGENTS).map((a) => [a.name, a.description]),
      [["reviewer", "Reviews"]],
    );
    const codex = listProjectAgents(project, CODEX_PROJECT_AGENTS);
    assert.deepEqual(
      codex.map((a) => [a.name, a.description, a.model, a.frontmatterError === null]),
      [
        ["planner", 'Plans "well"', "gpt-5", true],
        ["nameless", "no name", null, false],
      ],
    );
    assert.deepEqual(listProjectAgents(project), [], "the default is Claude Code's folder");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("listProjectAgents (Codex TOML) skips multi-line strings: no header or key is read inside them", () => {
  const project = mkdtempSync(path.join(tmpdir(), "duskfleet-toml-"));
  try {
    const dir = path.join(project, ".codex", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "a.toml"),
      [
        'developer_instructions = """',
        "[ ] todo",
        '[link](x) name = "x" \\""" still inside',
        'name = "wrong"',
        'model = "wrong"',
        '"""',
        "notes = '''",
        "[[not.a.table]]",
        "description = 'wrong'",
        "'''",
        'name = "planner"',
        'description = "Plans [things]" # a comment with """',
        'model = "gpt-5"',
        "",
        "[extra]",
        'model = "not this"',
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      listProjectAgents(project, CODEX_PROJECT_AGENTS).map((a) => [a.name, a.description, a.model]),
      [["planner", "Plans [things]", "gpt-5"]],
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("list_project_agents and create_agent over MCP answer for the agent's harness", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-guidance-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  writeFileSync(
    path.join(project, ".claude", "agents", "coordinator.md"),
    "---\nname: coordinator\n---\nCoordinate.\n",
  );
  // A Copilot agent too (#466): each harness lists only its own folder.
  mkdirSync(path.join(project, ".github", "agents"), { recursive: true });
  writeFileSync(
    path.join(project, ".github", "agents", "reviewer.agent.md"),
    "---\ndescription: Reviews\n---\nReview.\n",
  );
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), "---\nname: Coder\n---\nBe brief.\n");
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const call = async (name, args) => client.callTool({ name, arguments: args });
    const json = (r) => {
      assert.equal(r.isError ?? false, false, r.content?.[0]?.text);
      return JSON.parse(r.content[0].text);
    };

    // claude (default): unchanged answer, plus the folder and linkable
    const claude = json(await call("list_project_agents", { project_path: project }));
    assert.deepEqual(
      claude.agents.map((a) => a.name),
      ["coordinator"],
    );
    assert.equal(claude.harness, "claude");
    assert.equal(claude.linkable, true);
    assert.equal(claude.folder, ".claude/agents/<name>.md");

    // codex on a project that only has .claude/agents: no agents, the own-only hint
    const codex = json(await call("list_project_agents", { project_path: project, harness: "codex" }));
    assert.deepEqual(codex.agents, []);
    assert.equal(codex.linkable, false);
    assert.equal(codex.folder, ".codex/agents/<file>.toml");
    assert.match(codex.hint, /kind "own" on harness codex/);
    assert.match(codex.hint, /\.codex\/agents/);
    assert.doesNotMatch(codex.hint, /\.claude/);

    // a Codex link is refused before the folder is searched, with the remedy
    for (const [harness, folder] of [["codex", /\.codex\/agents/]]) {
      const refused = await call("create_agent", {
        id: `${harness}-link`,
        kind: "link",
        harness,
        claude_agent: "coordinator",
        project_path: project,
      });
      assert.equal(refused.isError, true);
      const text = refused.content[0].text;
      assert.match(text, new RegExp(`claude_agent is not supported by harness ${harness}`));
      assert.match(text, folder);
      assert.match(text, new RegExp(`kind "own" on harness ${harness}`));
    }

    // copilot lists .github/agents only, and can link since #466
    const listed = json(await call("list_project_agents", { project_path: project, harness: "copilot" }));
    assert.deepEqual(
      listed.agents.map((a) => a.name),
      ["reviewer"],
    );
    assert.equal(listed.linkable, true);
    assert.match(listed.hint, /project_agent: <name>/);

    // a Copilot link reads Copilot's folder only: the Claude agent is not one of its agents
    const copilot = await call("create_agent", {
      id: "copilot-link",
      kind: "link",
      harness: "copilot",
      project_agent: "coordinator",
      project_path: project,
    });
    assert.equal(copilot.isError, true);
    assert.match(copilot.content[0].text, /\.github\/agents has no agent "coordinator" \(available: reviewer\)/);
    const copilotLink = json(
      await call("create_agent", {
        id: "copilot-link",
        kind: "link",
        harness: "copilot",
        project_agent: "reviewer",
        permission_mode: "dontAsk",
        project_path: project,
      }),
    );
    assert.equal(copilotLink.agent.projectAgent, "reviewer");
    assert.equal(copilotLink.agent.projectAgentFile, ".github/agents/reviewer.agent.md");
    assert.equal(copilotLink.agent.description, "Reviews", "the project agent's description");

    // the Claude link still works as before
    const link = json(
      await call("create_agent", { id: "coord", kind: "link", claude_agent: "coordinator", project_path: project }),
    );
    assert.equal(link.kind, "link");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
