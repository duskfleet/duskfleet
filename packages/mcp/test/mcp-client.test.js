/**
 * Drives the real MCP server over stdio with the SDK client, using the fake
 * Claude binary. Verifies the first-milestone flow end to end:
 * connect -> list tools -> run_agent -> get_run -> list_runs -> cancel_run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "./helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

function parse(result) {
  assert.equal(result.isError ?? false, false, `tool returned error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test("MCP client can run an agent and inspect the run", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-mcp-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(path.join(configDir, "duskfleet.yaml"), `data_dir: ../data\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n`);
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\nname: Coder\n---\nBe brief.\n`);
  writeFileSync(path.join(configDir, "projects.yaml"), `projects:\n  demo:\n    path: ${project}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: testEnv({ DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await client.connect(transport);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["cancel_run", "create_agent", "create_schedule", "delete_agent", "delete_schedule", "get_run", "list_agents", "list_project_agents", "list_projects", "list_runs", "list_schedules", "run_agent", "run_schedule_now", "update_agent", "update_schedule"]);

    // the build-time catalogue the dashboard renders must match the live server
    const catalog = JSON.parse(readFileSync(path.join(here, "..", "dist", "tools.json"), "utf8"));
    assert.deepEqual(catalog.tools.map((t) => t.name).sort(), tools, "dist/tools.json is stale: run npm run build");
    assert.ok(catalog.tools.every((t) => t.description && t.inputSchema && t.group));
    assert.equal(catalog.tools.find((t) => t.name === "run_agent").group, "runs");

    const agents = parse(await client.callTool({ name: "list_agents", arguments: {} }));
    assert.equal(agents.agents[0].id, "coder");

    const projects = parse(await client.callTool({ name: "list_projects", arguments: {} }));
    assert.equal(projects.projects[0].id, "demo");

    const started = parse(await client.callTool({ name: "run_agent", arguments: { prompt: "ok", project_id: "demo" } }));
    assert.equal(started.status, "running");
    assert.match(started.resumeCommand, /^claude --resume /);

    let run;
    for (let i = 0; i < 50; i++) {
      run = parse(await client.callTool({ name: "get_run", arguments: { run_id: started.id, include_output: true } }));
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(run.status, "completed");
    assert.equal(run.resultText, "Done: created hello.txt");
    assert.equal(run.costUsd, 0.0123);
    assert.ok(Array.isArray(run.events) && run.events.some((e) => e.type === "tool_use"));

    const waited = parse(await client.callTool({ name: "run_agent", arguments: { prompt: "ok", project_path: project, wait_seconds: 10 } }));
    assert.equal(waited.status, "completed");

    const hanging = parse(await client.callTool({ name: "run_agent", arguments: { prompt: "hang", project_path: project } }));
    const cancelled = parse(await client.callTool({ name: "cancel_run", arguments: { run_id: hanging.id } }));
    assert.equal(cancelled.status, "cancelled");

    const list = parse(await client.callTool({ name: "list_runs", arguments: { limit: 10 } }));
    assert.equal(list.runs.length, 3);

    const bad = await client.callTool({ name: "run_agent", arguments: { prompt: "ok", project_path: "/definitely/not/here" } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
