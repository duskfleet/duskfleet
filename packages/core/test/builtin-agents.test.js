/**
 * Builtin agents shipped in config/agents: they load, are general-purpose and fit for a public
 * repo, and the read-only ones cannot edit files.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentToSpec, assertAgentSpecClean, loadAgents } from "@duskfleet/core";

const builtinDir = fileURLToPath(new URL("../../../config/agents", import.meta.url));

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
