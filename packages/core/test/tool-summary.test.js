/** Tool summaries: denied tools per name from a result line, and the MCP mount / allow-list mismatch. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowListedMcpMissing,
  createStreamState,
  ingestLine,
  mcpToolPrefix,
  summarizeToolInput,
} from "@duskfleet/core";

test("summarizeToolInput picks the field that names the call", () => {
  assert.equal(summarizeToolInput("Bash", { command: "npm   test\n -- x", description: "tests" }), "npm test -- x");
  assert.equal(summarizeToolInput("Edit", { file_path: "/w/a.ts", old_string: "x" }), "/w/a.ts");
  assert.equal(summarizeToolInput("NotebookEdit", { notebook_path: "/w/n.ipynb" }), "/w/n.ipynb");
  assert.equal(summarizeToolInput("Grep", { pattern: "TODO", path: "src" }), "TODO");
  assert.equal(summarizeToolInput("Agent", { prompt: "long brief", description: "Review" }), "Review");
  assert.equal(summarizeToolInput("mcp__claude_ai_Figma__use_figma", { fileKey: "abc", nodeId: "1:2" }), "abc");
  assert.equal(summarizeToolInput("WebFetch", { url: "https://example.com", prompt: "read" }), "https://example.com");
  assert.equal(summarizeToolInput("Bash", "not an object"), null);
  assert.equal(summarizeToolInput("Bash", { command: "   " }), null);
  assert.equal(summarizeToolInput("Bash", { command: "x".repeat(200) }, 10), `${"x".repeat(9)}…`);
});

test("permission denials become one DeniedTool per entry, summarized by tool name", () => {
  const state = createStreamState();
  ingestLine(
    state,
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s",
      result: "done",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git push --force" } },
        { tool_name: "Write", tool_use_id: "t2", tool_input: { file_path: "/etc/hosts", content: "x" } },
        { tool_name: "Bash", tool_use_id: "t3", tool_input: { command: "rm -rf build" } },
        { tool_use_id: "t4" },
        "not an object",
      ],
    }),
  );
  assert.equal(state.result.permissionDenials, 4, "non-object entries are dropped");
  assert.deepEqual(state.result.deniedTools, [
    { tool: "Bash", summary: "git push --force" },
    { tool: "Write", summary: "/etc/hosts" },
    { tool: "Bash", summary: "rm -rf build" },
    { tool: "unknown", summary: null },
  ]);
});

test("a result line without permission_denials has none", () => {
  const state = createStreamState();
  ingestLine(state, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }));
  assert.equal(state.result.permissionDenials, 0);
  assert.deepEqual(state.result.deniedTools, []);
});

test("mcpToolPrefix follows Claude Code's naming", () => {
  assert.equal(mcpToolPrefix("claude.ai Figma"), "mcp__claude_ai_Figma");
  assert.equal(mcpToolPrefix("claude.ai Atlassian Rovo"), "mcp__claude_ai_Atlassian_Rovo");
  assert.equal(mcpToolPrefix("my-server_2"), "mcp__my-server_2");
});

test("allow-listed MCP servers that neither mounted nor were called are missing", () => {
  const allowed = [
    "Read",
    "Bash(npm test:*)",
    "mcp__claude_ai_Figma",
    "mcp__claude_ai_Atlassian_Rovo__getJiraIssue",
    "mcp__claude_ai_Atlassian_Rovo__searchJira",
    "mcp__claude_ai_Gmail__send",
  ];
  const mounted = [{ name: "claude.ai Figma", status: "connected" }];
  assert.deepEqual(allowListedMcpMissing(allowed, mounted, []), [
    "mcp__claude_ai_Atlassian_Rovo",
    "mcp__claude_ai_Gmail",
  ]);
  assert.deepEqual(
    allowListedMcpMissing(allowed, mounted, ["mcp__claude_ai_Gmail"]),
    ["mcp__claude_ai_Atlassian_Rovo"],
    "a server actually called is not missing even when it was not in the init list",
  );
});

test("no MCP evidence at all (nothing mounted, nothing called) reports nothing missing", () => {
  assert.deepEqual(allowListedMcpMissing(["mcp__claude_ai_Figma"], [], []), []);
});

test("an empty mounted list (deferred connectors) with one server called reports nothing missing", () => {
  assert.deepEqual(
    allowListedMcpMissing(["mcp__example_tracker", "mcp__example_design"], [], ["mcp__example_tracker"]),
    [],
  );
});

test("an allow-list without mcp__ entries never reports a mismatch", () => {
  assert.deepEqual(allowListedMcpMissing(["Read", "Bash"], [{ name: "claude.ai Figma" }], []), []);
});
