import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTarget } from "../lib/link-target.ts";

test("linkTarget: a Claude Code link is .claude/agents/<name>.md, run as claude --agent", () => {
  const t = linkTarget({}, "builder");
  assert.equal(t.file, ".claude/agents/builder.md");
  assert.equal(t.command, "claude --agent builder");
  assert.equal(t.folder.dir, ".claude/agents");
  assert.equal(linkTarget({ harness: "claude" }, "builder").file, ".claude/agents/builder.md");
});

test("linkTarget: a Copilot link is .github/agents/<name>.agent.md, run as copilot --agent", () => {
  const t = linkTarget({ harness: "copilot" }, "pim");
  assert.equal(t.file, ".github/agents/pim.agent.md");
  assert.equal(t.command, "copilot --agent pim");
  assert.equal(t.folder.dir, ".github/agents");
});
