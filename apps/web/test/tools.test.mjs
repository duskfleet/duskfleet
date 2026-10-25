import assert from "node:assert/strict";
import { test } from "node:test";
import { filterTools } from "../lib/tools.ts";

const tools = [
  { name: "run_agent", inputSchema: { properties: { agent_id: {}, prompt: {}, wait_seconds: {} } } },
  { name: "list_runs", inputSchema: { properties: { status: {}, limit: {} } } },
  { name: "list_projects", inputSchema: { properties: {} } },
  { name: "list_agents" },
];
const names = (list) => list.map((t) => t.name);

test("filterTools keeps every tool for an empty or blank query", () => {
  assert.deepEqual(names(filterTools(tools, undefined)), names(tools));
  assert.deepEqual(names(filterTools(tools, "")), names(tools));
  assert.deepEqual(names(filterTools(tools, "   ")), names(tools));
});

test("filterTools matches tool names case-insensitively", () => {
  assert.deepEqual(names(filterTools(tools, "LIST")), ["list_runs", "list_projects", "list_agents"]);
  assert.deepEqual(names(filterTools(tools, "projects")), ["list_projects"]);
});

test("filterTools matches parameter names too", () => {
  assert.deepEqual(names(filterTools(tools, "wait_seconds")), ["run_agent"]);
  assert.deepEqual(names(filterTools(tools, "limit")), ["list_runs"]);
});

test("filterTools reads spaces as underscores", () => {
  assert.deepEqual(names(filterTools(tools, "run agent")), ["run_agent"]);
  assert.deepEqual(names(filterTools(tools, "  wait   seconds ")), ["run_agent"]);
});

test("filterTools returns nothing when no name matches", () => {
  assert.deepEqual(filterTools(tools, "budget"), []);
});
