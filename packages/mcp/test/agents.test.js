/**
 * Agent management over MCP: create_agent / update_agent / delete_agent write
 * Markdown files into user_agents_dir, never into config/agents, and the new
 * agent is runnable right away (config is re-read per call).
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

function ok(result) {
  assert.equal(result.isError ?? false, false, `tool returned error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}
function fails(result, pattern) {
  assert.equal(result.isError, true, "expected the tool to fail");
  assert.match(result.content[0].text, pattern);
}

test("agents can be created, updated, run and deleted over MCP without touching config/agents", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-agents-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\nname: Coder\n---\nBe brief.\n`);
  const userDir = path.join(root, "data", "agents");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await client.connect(transport);

    // create
    const created = ok(
      await client.callTool({
        name: "create_agent",
        arguments: {
          id: "test-fixer",
          kind: "own",
          description: "Fixes tests",
          model: "haiku",
          allowed_tools: ["Bash(npm test:*)"],
          max_budget_usd: 1,
          system_prompt: "Fix the tests. Never edit them.",
        },
      }),
    );
    assert.equal(created.created, true);
    assert.equal(created.agent.source, "user");
    assert.equal(created.agent.path, path.join(userDir, "test-fixer.md"));
    assert.ok(existsSync(created.agent.path));
    assert.deepEqual(readdirSync(path.join(configDir, "agents")), ["coder.md"], "config/agents must stay untouched");
    const md = readFileSync(created.agent.path, "utf8");
    assert.match(md, /^---\n/);
    assert.match(md, /model: haiku/);
    assert.match(md, /Fix the tests\. Never edit them\./);

    // visible immediately, and runnable
    const listed = ok(await client.callTool({ name: "list_agents", arguments: {} }));
    assert.deepEqual(listed.agents.map((a) => `${a.id}:${a.source}`).sort(), ["coder:builtin", "test-fixer:user"]);
    assert.equal(listed.userAgentsDir, userDir);

    const run = ok(
      await client.callTool({
        name: "run_agent",
        arguments: { prompt: "go", project_path: project, agent_id: "test-fixer", wait_seconds: 10 },
      }),
    );
    assert.equal(run.status, "completed");
    assert.equal(run.agentId, "test-fixer");
    assert.ok(run.command.argv.includes("--allowedTools"));
    assert.ok(run.command.argv.includes("Bash(npm test:*)"));
    // max_budget_usd 1 → $0.50 for the main pass, $0.50 reserve for the wrap-up pass (10% floored at $0.50, capped at half)
    assert.equal(run.command.argv[run.command.argv.indexOf("--max-budget-usd") + 1], "0.5");
    assert.equal(created.agent.wrapUpReserveUsd, 0.5, "list/create report the effective reserve");

    assert.equal(created.kind, "own");
    assert.equal(created.agent.kind, "own");
    // duplicate id without overwrite
    fails(
      await client.callTool({ name: "create_agent", arguments: { id: "test-fixer", kind: "own", system_prompt: "x" } }),
      /already exists/,
    );
    // builtin id without overwrite
    fails(
      await client.callTool({ name: "create_agent", arguments: { id: "coder", kind: "own", system_prompt: "x" } }),
      /builtin agent/,
    );
    // bypassPermissions is not offered
    const bypass = await client.callTool({
      name: "create_agent",
      arguments: { id: "danger", kind: "own", system_prompt: "x", permission_mode: "bypassPermissions" },
    });
    assert.equal(bypass.isError, true);
    // the kind is mandatory and must be consistent with the fields
    const noKind = await client.callTool({ name: "create_agent", arguments: { id: "nokind", system_prompt: "x" } });
    assert.equal(noKind.isError, true, "kind is required");
    fails(
      await client.callTool({ name: "create_agent", arguments: { id: "empty-own", kind: "own" } }),
      /needs a system_prompt/,
    );
    fails(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "mixed", kind: "own", system_prompt: "x", claude_agent: "whatever" },
      }),
      /cannot have claude_agent/,
    );
    fails(
      await client.callTool({ name: "create_agent", arguments: { id: "link-no-target", kind: "link" } }),
      /needs claude_agent/,
    );

    // update merges and can clear optional fields
    const updated = ok(
      await client.callTool({
        name: "update_agent",
        arguments: { id: "test-fixer", description: "Fixes failing tests", clear: ["max_budget_usd"] },
      }),
    );
    assert.equal(updated.agent.description, "Fixes failing tests");
    assert.equal(updated.agent.model, "haiku", "untouched fields are kept");
    assert.deepEqual(updated.agent.allowedTools, ["Bash(npm test:*)"]);
    assert.equal(updated.agent.maxBudgetUsd, 5, "cleared field falls back to the global default");
    assert.equal(updated.agent.systemPrompt, "Fix the tests. Never edit them.");

    // builtin agents are protected
    fails(
      await client.callTool({ name: "update_agent", arguments: { id: "coder", description: "x" } }),
      /builtin agent/,
    );
    fails(await client.callTool({ name: "delete_agent", arguments: { id: "coder" } }), /cannot be deleted/);

    // user override of a builtin, then delete falls back to the builtin
    const override = ok(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "coder", kind: "own", overwrite: true, model: "haiku", system_prompt: "Override." },
      }),
    );
    assert.equal(override.overrode, "builtin");
    assert.equal(
      ok(await client.callTool({ name: "list_agents", arguments: {} })).agents.find((a) => a.id === "coder").source,
      "user",
    );
    const deleted = ok(await client.callTool({ name: "delete_agent", arguments: { id: "coder" } }));
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.nowResolvesTo.source, "builtin");

    // link to an agent the project defines
    mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
    writeFileSync(
      path.join(project, ".claude", "agents", "coordinator.md"),
      `---\nname: coordinator\ndescription: Runs the show\ntools: Read, Grep\nmodel: claude-sonnet-5\n---\nYou coordinate.\n`,
    );
    const projectAgents = ok(
      await client.callTool({ name: "list_project_agents", arguments: { project_path: project } }),
    );
    assert.deepEqual(
      projectAgents.agents.map((a) => [a.name, a.tools, a.model]),
      [["coordinator", ["Read", "Grep"], "claude-sonnet-5"]],
    );
    // a link needs the folder that defines the agent
    fails(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "sl-coordinator", kind: "link", claude_agent: "coordinator" },
      }),
      /pass project_path/,
    );
    // pointing at a folder without .claude/agents is refused
    const bare = path.join(root, "bare");
    mkdirSync(bare);
    fails(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "sl-coordinator", kind: "link", claude_agent: "coordinator", project_path: bare },
      }),
      /no \.claude\/agents/,
    );
    // a folder with agents but not yet a project: registered privately under the folder name, agent bound to it
    const linkedByPath = ok(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "by-path", kind: "link", claude_agent: "coordinator", project_path: project },
      }),
    );
    assert.equal(linkedByPath.kind, "link");
    assert.equal(linkedByPath.agent.project, "project", "slug of the folder name");
    assert.equal(linkedByPath.project.path, realpathSync(project));
    assert.match(readFileSync(path.join(root, "data", "projects.yaml"), "utf8"), /project:\n\s+path: /);
    assert.ok(
      ok(await client.callTool({ name: "list_projects", arguments: {} })).projects.some((p) => p.id === "project"),
    );
    // same folder again with a different id → refused (already registered)
    fails(
      await client.callTool({
        name: "create_agent",
        arguments: {
          id: "by-path-2",
          kind: "link",
          claude_agent: "coordinator",
          project_path: project,
          project: "other",
        },
      }),
      /already registered as project "project"/,
    );
    ok(await client.callTool({ name: "delete_agent", arguments: { id: "by-path" } }));
    // now register the same folder under the id "demo" the rest of the test expects
    writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  demo:\n    path: ${project}\n`);
    writeFileSync(path.join(root, "data", "projects.yaml"), `projects: {}\n`);
    fails(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "sl-coordinator", kind: "link", claude_agent: "nope", project: "demo" },
      }),
      /defines no agent "nope".*available: coordinator/,
    );
    const linked = ok(
      await client.callTool({
        name: "create_agent",
        arguments: {
          id: "sl-coordinator",
          kind: "link",
          claude_agent: "coordinator",
          project: "demo",
          permission_mode: "dontAsk",
        },
      }),
    );
    assert.equal(linked.kind, "link");
    assert.equal(linked.agent.kind, "link");
    assert.equal(linked.agent.claudeAgent, "coordinator");
    // unlink via update: becomes "own", so it needs a prompt
    fails(
      await client.callTool({ name: "update_agent", arguments: { id: "sl-coordinator", clear: ["claude_agent"] } }),
      /needs a system_prompt/,
    );
    const unlinked = ok(
      await client.callTool({
        name: "update_agent",
        arguments: { id: "sl-coordinator", clear: ["claude_agent"], system_prompt: "Now on my own." },
      }),
    );
    assert.equal(unlinked.kind, "own");
    const relinked = ok(
      await client.callTool({
        name: "update_agent",
        arguments: { id: "sl-coordinator", kind: "link", claude_agent: "coordinator" },
      }),
    );
    assert.equal(relinked.agent.claudeAgent, "coordinator");
    const linkedRun = ok(
      await client.callTool({
        name: "run_agent",
        arguments: { prompt: "go", agent_id: "sl-coordinator", wait_seconds: 10 },
      }),
    );
    assert.equal(linkedRun.status, "completed");
    const ai = linkedRun.command.argv.indexOf("--agent");
    assert.ok(ai >= 0 && linkedRun.command.argv[ai + 1] === "coordinator", "--agent is passed to claude");

    // project binding: default target, refused elsewhere, grouped in list_agents
    const bound = ok(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "demo-bot", kind: "own", project: "demo", system_prompt: "Demo only." },
      }),
    );
    assert.equal(bound.agent.project, "demo");
    const grouped = ok(await client.callTool({ name: "list_agents", arguments: {} }));
    assert.deepEqual(grouped.byProject["demo"].sort(), ["demo-bot", "sl-coordinator"]);
    assert.ok(grouped.byProject["(any project)"].includes("coder"));
    const defaulted = ok(
      await client.callTool({ name: "run_agent", arguments: { prompt: "ok", agent_id: "demo-bot", wait_seconds: 10 } }),
    );
    assert.equal(defaulted.projectId, "demo");
    assert.equal(defaulted.status, "completed");
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    fails(
      await client.callTool({
        name: "run_agent",
        arguments: { prompt: "ok", agent_id: "demo-bot", project_path: elsewhere },
      }),
      /belongs to project "demo"/,
    );
    fails(
      await client.callTool({
        name: "create_agent",
        arguments: { id: "ghost", kind: "own", system_prompt: "x", project: "no-such-project" },
      }),
      /not in projects.yaml/,
    );

    // delete a plain user agent
    const gone = ok(await client.callTool({ name: "delete_agent", arguments: { id: "test-fixer" } }));
    assert.equal(gone.deleted, true);
    assert.equal(gone.nowResolvesTo, null);
    assert.ok(!existsSync(path.join(userDir, "test-fixer.md")));
    fails(await client.callTool({ name: "delete_agent", arguments: { id: "test-fixer" } }), /unknown agent/);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
