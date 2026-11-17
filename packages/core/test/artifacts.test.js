/**
 * Run artifacts (issue #382): PR URLs from the main session's `gh pr create` output, and from the
 * final text only when that output produced a PR or was not available. Plus the parser's
 * `bash_result` event the extraction is fed from.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createStreamState, extractArtifacts, ingestLine, isPrCreateCommand, prUrls } from "@duskfleet/core";

const PR = "https://github.com/example/demo/pull/8";

test("prUrls: PR URLs once each, in order; push's /pull/new/<branch> hint is not one", () => {
  assert.deepEqual(prUrls(null), []);
  assert.deepEqual(prUrls("remote: https://github.com/example/demo/pull/new/issue/7-fix"), []);
  assert.deepEqual(prUrls(`Opened ${PR}. Also https://github.com/other-org/repo.js/pull/12, again ${PR}.`), [
    PR,
    "https://github.com/other-org/repo.js/pull/12",
  ]);
  assert.deepEqual(prUrls(`${PR}/files`), [PR]);
  assert.deepEqual(prUrls("https://example.com/a/b/pull/3"), []);
});

test("isPrCreateCommand is a substring test on the command text", () => {
  assert.equal(isPrCreateCommand("gh pr create --base main --title 'x' --body-file b.md"), true);
  assert.equal(isPrCreateCommand("cd /w && gh pr create --fill"), true);
  assert.equal(isPrCreateCommand("gh pr view 8"), false);
  assert.equal(isPrCreateCommand("git push -u origin x"), false);
});

test("a successful gh pr create that printed the URL: one tool_result artifact, the final text adds nothing new", () => {
  const found = extractArtifacts({
    prCreateResults: [{ output: `${PR}\n`, isError: false }],
    unansweredPrCreates: 0,
    resultText: `Opened ${PR}.`,
  });
  assert.deepEqual(found, [{ kind: "pr", value: PR, source: "tool_result" }]);
});

test("a run that created a PR also records other PR URLs of its final text", () => {
  const found = extractArtifacts({
    prCreateResults: [{ output: PR, isError: false }],
    unansweredPrCreates: 0,
    resultText: `Opened ${PR} and https://github.com/example/demo/pull/9.`,
  });
  assert.deepEqual(found, [
    { kind: "pr", value: PR, source: "tool_result" },
    { kind: "pr", value: "https://github.com/example/demo/pull/9", source: "result_text" },
  ]);
});

test("gh pr create failed (is_error, even with a URL) or printed no URL: nothing, whatever the final text says", () => {
  for (const r of [
    { output: `a pull request for branch "x" into branch "main" already exists:\n${PR}`, isError: true },
    { output: "pull request create failed: GraphQL: No commits between main and x", isError: false },
    { output: "Exit code 1\nmust be on a branch", isError: true },
  ]) {
    assert.deepEqual(
      extractArtifacts({ prCreateResults: [r], unansweredPrCreates: 0, resultText: `Opened ${PR}.` }),
      [],
      r.output,
    );
  }
});

test("a PR only mentioned in prose by a run that ran no gh pr create is not an artifact", () => {
  assert.deepEqual(
    extractArtifacts({ prCreateResults: [], unansweredPrCreates: 0, resultText: `Reviewed ${PR}: looks good.` }),
    [],
  );
});

test("gh pr create ran but no output was available (no tool_result, or an empty one): the final text counts", () => {
  const expected = [{ kind: "pr", value: PR, source: "result_text" }];
  assert.deepEqual(
    extractArtifacts({ prCreateResults: [], unansweredPrCreates: 1, resultText: `Opened ${PR}.` }),
    expected,
  );
  assert.deepEqual(
    extractArtifacts({ prCreateResults: [{ output: null, isError: false }], unansweredPrCreates: 0, resultText: PR }),
    expected,
  );
});

test("parser: a Bash tool_result is a bash_result event with the call's command, output, is_error and session", () => {
  const state = createStreamState();
  const feed = (o) => ingestLine(state, JSON.stringify(o));
  feed({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }],
    },
    parent_tool_use_id: null,
  });
  const events = feed({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: PR }] }] },
    parent_tool_use_id: null,
  });
  assert.deepEqual(events, [
    { type: "bash_result", toolUseId: "t1", command: "gh pr create --fill", output: PR, isError: false, agentId: null },
  ]);
  // A second result for the same id (none expected) is not a Bash result any more.
  assert.deepEqual(
    feed({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "again" }] },
    }).filter((e) => e.type === "bash_result"),
    [],
  );
});

test("parser: a subagent's Bash result carries the subagent's agent id", () => {
  const state = createStreamState();
  const feed = (o) => ingestLine(state, JSON.stringify(o));
  const nested = { parent_tool_use_id: "t_agent", agent_id: "A", subagent_type: "dev" };
  feed({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "gh pr create --fill" } }] },
    ...nested,
  });
  const events = feed({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t2", content: PR, is_error: true }] },
    ...nested,
  });
  const bash = events.find((e) => e.type === "bash_result");
  assert.equal(bash.agentId, "A");
  assert.equal(bash.isError, true);
});
