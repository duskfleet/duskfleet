/**
 * Builtin agents shipped in config/agents: they load, are general-purpose and fit for a public
 * repo, carry the unattended envelope, and the read-only ones cannot edit files. No model call.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentToSpec, assertAgentSpecClean, loadAgents } from "@duskfleet/core";

const builtinDir = fileURLToPath(new URL("../../../config/agents", import.meta.url));
const builtinFiles = readdirSync(builtinDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

/** Raw frontmatter of a builtin file: the loader fills defaults, so "stated explicitly" needs the text. */
function rawFrontmatter(file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path.join(builtinDir, file), "utf8"));
  assert.ok(match, `${file}: starts with a YAML frontmatter block`);
  return match[1];
}

test("config/agents is not empty and every file loads as one agent named after it", () => {
  // An empty directory would make every other test here pass without checking anything.
  assert.ok(builtinFiles.length > 0, "config/agents ships at least one builtin");
  const agents = loadAgents(builtinDir, "builtin");
  assert.equal(agents.size, builtinFiles.length, "every .md file is one agent");
  for (const file of builtinFiles) {
    const id = file.replace(/\.md$/, "");
    assert.ok(agents.has(id), `${file}: its id is its file name`);
  }
});

test("every builtin agent carries the unattended envelope", () => {
  const agents = loadAgents(builtinDir, "builtin");
  for (const file of builtinFiles) {
    const agent = agents.get(file.replace(/\.md$/, ""));
    assert.match(rawFrontmatter(file), /^permission_mode:/m, `${file}: states permission_mode, no silent default`);
    // plan blocks Bash, MCP and writes unattended; bypassPermissions is refused with --permission-prompts none.
    assert.ok(
      ["acceptEdits", "dontAsk"].includes(agent.permissionMode),
      `${agent.id}: permission_mode is acceptEdits or dontAsk, not ${agent.permissionMode}`,
    );
    assert.ok(agent.timeoutMinutes > 0, `${agent.id}: sets timeout_minutes`);
    assert.ok(agent.maxBudgetUsd > 0, `${agent.id}: sets max_budget_usd`);
    assert.match(agent.systemPrompt, /\bunattended\b/i, `${agent.id}: the prompt says it runs unattended`);
    assert.match(agent.systemPrompt, /nobody can answer/i, `${agent.id}: the prompt says nobody can answer a question`);
  }
});

test("every read-only builtin (isolated: true) is dontAsk and cannot edit files", () => {
  // isolated: true is the agent's promise never to edit the checkout (CLAUDE.md "Concurrency guards").
  const editTools = ["Edit", "Write", "NotebookEdit"];
  for (const agent of loadAgents(builtinDir, "builtin").values()) {
    if (!agent.isolated) continue;
    assert.equal(agent.permissionMode, "dontAsk", `${agent.id}: read-only = dontAsk (plan is useless unattended)`);
    for (const tool of editTools) {
      assert.ok(agent.disallowedTools?.includes(tool), `${agent.id}: disallows ${tool}`);
      assert.ok(!(agent.allowedTools ?? []).includes(tool), `${agent.id}: does not allow ${tool}`);
    }
  }
});

test("every builtin agent loads, is an own agent bound to no project, sets a model and is clean", () => {
  const agents = loadAgents(builtinDir, "builtin");
  for (const agent of agents.values()) {
    assert.equal(agent.project, undefined, `${agent.id}: builtins are not bound to a project`);
    assert.equal(agent.claudeAgent, undefined, `${agent.id}: builtins are own agents`);
    assert.ok(agent.model, `${agent.id}: builtins set a model (the CLI default can cost far more)`);
    assert.ok(agent.systemPrompt.length > 0, `${agent.id}: own agents need a prompt`);
    assert.equal(agent.addDirs, undefined, `${agent.id}: add_dirs are machine paths, set them on the project`);
    assert.doesNotThrow(() => assertAgentSpecClean(agentToSpec(agent)), agent.id);
  }
});

test("why-work-stopped is read-only: dontAsk, no edit tools, SELECT through sqlite3 -readonly -safe only", () => {
  const agent = loadAgents(builtinDir, "builtin").get("why-work-stopped");
  assert.ok(agent, "why-work-stopped ships as a builtin");
  assert.equal(agent.permissionMode, "dontAsk", "plan mode is useless unattended; read-only = dontAsk");
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
    assert.ok(agent.disallowedTools?.includes(tool), `why-work-stopped disallows ${tool}`);
  }
  const bash = (agent.allowedTools ?? []).filter((t) => t.startsWith("Bash"));
  assert.deepEqual(
    bash,
    ["Bash(sqlite3 -readonly -safe:*)"],
    "the only shell access is a read-only sqlite3 in safe mode (no .shell / .system / .output)",
  );
  assert.match(agent.systemPrompt, /sqlite3 -readonly -safe /, "the prompt uses the allow-listed prefix");
  assert.equal(agent.isolated, true, "it never edits the checkout, so it may run beside the agent it diagnoses");
  assert.match(agent.systemPrompt, /skipped_busy/);
  assert.match(agent.systemPrompt, /review_reasons_json/);
  // Every outcome and review reason the core can store is named, so the agent can read them.
  for (const word of ["skipped_budget", "budgets", "empty_run", "max_concurrent_runs", "kind = 'gate'"]) {
    assert.ok(agent.systemPrompt.includes(word), `the prompt explains ${word}`);
  }
  assert.match(agent.systemPrompt, /never\s+output\s+a\s+diff\s+or\s+a\s+patch/);
});
