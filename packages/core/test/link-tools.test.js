/**
 * Link agents (#458): `allowed_tools` entries the project agent's `tools:` does not declare.
 * Pure comparison (`linkToolGaps`) plus the file-reading wrappers. No model call.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { linkToolCheck, linkToolGaps, linkToolWarnings, listProjectAgents } from "@duskfleet/core";

const agent = (tools) => ({ tools, frontmatterError: null });

test("linkToolGaps: a plain tool is covered by the same name, missing otherwise", () => {
  assert.deepEqual(linkToolGaps(["Read", "Edit"], agent(["Read", "Grep"])), { missing: ["Edit"], skipped: null });
  assert.deepEqual(linkToolGaps(undefined, agent(["Read"])), { missing: [], skipped: null });
});

test("linkToolGaps: a rule with arguments compares by the tool name before the parenthesis", () => {
  assert.deepEqual(linkToolGaps(["Bash(gh issue view:*)", "Read(src/**)"], agent(["Bash", "Read"])).missing, []);
  assert.deepEqual(linkToolGaps(["Bash(npm test:*)"], agent(["Read"])).missing, ["Bash(npm test:*)"], "verbatim");
  assert.deepEqual(linkToolGaps(["Bash"], agent(["Bash(npm test:*)"])).missing, [], "declared rules count by name");
});

test("linkToolGaps: MCP names compare by server; a server and its tools cover each other", () => {
  const figma = agent(["Read", "mcp__claude_ai_Figma"]);
  assert.deepEqual(linkToolGaps(["mcp__claude_ai_Figma", "mcp__claude_ai_Figma__get_screenshot"], figma).missing, []);
  assert.deepEqual(
    linkToolGaps(["mcp__claude_ai_Figma"], agent(["mcp__claude_ai_Figma__get_screenshot"])).missing,
    [],
    "a tool of the server covers the server entry",
  );
  assert.deepEqual(
    linkToolGaps(["mcp__claude_ai_Figma__get_code"], agent(["mcp__claude_ai_Figma__get_screenshot"])).missing,
    ["mcp__claude_ai_Figma__get_code"],
    "two tools of one server do not cover each other",
  );
  assert.deepEqual(
    linkToolGaps(["mcp__claude_ai_Figma"], agent(["Read", "mcp__plugin_figma_figma"])).missing,
    ["mcp__claude_ai_Figma"],
    "another prefix is another server",
  );
  assert.deepEqual(linkToolGaps(["mcp__claude_ai_Figma__get_code"], agent(["mcp__claude_ai_Figma__*"])).missing, []);
});

test("linkToolGaps: a project agent without tools: inherits every tool", () => {
  assert.deepEqual(linkToolGaps(["Bash(npm test:*)", "mcp__claude_ai_Figma"], agent(null)), {
    missing: [],
    skipped: null,
  });
});

test("linkToolGaps: unparsable frontmatter skips the check with one note", () => {
  const r = linkToolGaps(["Edit"], { tools: null, frontmatterError: "bad indentation" });
  assert.deepEqual(r.missing, []);
  assert.match(r.skipped, /frontmatter does not parse \(bad indentation\)/);
});

test("linkToolGaps: no allowed_tools means nothing to check, so no note even for unparsable frontmatter", () => {
  const broken = { tools: null, frontmatterError: "bad indentation" };
  assert.deepEqual(linkToolGaps(undefined, broken), { missing: [], skipped: null });
  assert.deepEqual(linkToolGaps([], broken), { missing: [], skipped: null });
});

test("linkToolCheck / linkToolWarnings read the project agent file; own agents and unknown agents get nothing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-link-tools-"));
  try {
    const dir = path.join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "designer.md"), "---\nname: designer\ntools: Read, Grep\n---\nDesign.\n");
    writeFileSync(path.join(dir, "broken.md"), "---\ntools: [Read\n  nope: : :\n---\nBroken.\n");

    const designer = path.join(dir, "designer.md");
    assert.deepEqual(
      linkToolCheck({ claude_agent: "designer", allowed_tools: ["Read", "mcp__claude_ai_Figma"] }, root),
      {
        file: designer,
        missing: ["mcp__claude_ai_Figma"],
        skipped: null,
      },
    );
    const warnings = linkToolWarnings({ claude_agent: "designer", allowed_tools: ["mcp__claude_ai_Figma"] }, root);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(`"mcp__claude_ai_Figma" is not in the tools: of ${designer}`));
    assert.deepEqual(linkToolWarnings({ claude_agent: "designer", allowed_tools: ["Grep"] }, root), []);

    assert.ok(listProjectAgents(root).find((a) => a.name === "broken").frontmatterError, "the parse error is kept");
    const skipped = linkToolWarnings({ claude_agent: "broken", allowed_tools: ["Edit"] }, root);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /not checked against .*broken\.md: its frontmatter does not parse/);

    assert.equal(linkToolCheck({ allowed_tools: ["Edit"] }, root), null, "own agent");
    assert.equal(linkToolCheck({ claude_agent: "nope", allowed_tools: ["Edit"] }, root), null, "unknown project agent");
    assert.equal(linkToolCheck({ claude_agent: "designer", allowed_tools: ["Edit"] }, null), null, "unknown project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
