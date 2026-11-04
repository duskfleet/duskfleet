/**
 * Run artifacts (issue #382): PRs, branches and commits read from the main session's Bash output
 * and from the final text. Output shapes are git 2.4x / gh 2.x as an agent's Bash tool_result
 * carries them (stdout + stderr in one string).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifactsFromBash,
  artifactsFromResultText,
  createStreamState,
  ingestLine,
  shellSegments,
  uniqueArtifacts,
} from "@duskfleet/core";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const kv = (findings) => findings.map((f) => `${f.kind}:${f.value}`);

test("shellSegments splits chains and strips quotes", () => {
  assert.deepEqual(shellSegments(`cd /w && git push origin "a b" ; echo 'x|y' | wc`), [
    ["cd", "/w"],
    ["git", "push", "origin", "a b"],
    ["echo", "x|y"],
    ["wc"],
  ]);
  assert.deepEqual(shellSegments("git push \\\n  origin main"), [["git", "push", "origin", "main"]]);
});

test("git push: branch from the refspec and from a new-branch report", () => {
  const out =
    "remote: Create a pull request for 'issue/7-x' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/issue/7-x\nTo github.com:o/r.git\n * [new branch]      issue/7-x -> issue/7-x\nbranch 'issue/7-x' set up to track 'origin/issue/7-x'.";
  assert.deepEqual(kv(artifactsFromBash("git -C /w/r push -u origin issue/7-x", out)), [
    "branch:issue/7-x",
    "branch:issue/7-x",
  ]);
  // the pull/new link of the remote banner is not a PR
  assert.ok(artifactsFromBash("git push -u origin issue/7-x", out).every((f) => f.kind !== "pr"));
});

test("git push: refspec forms and the update line's new SHA", () => {
  assert.deepEqual(kv(artifactsFromBash("git push origin HEAD:refs/heads/feat/a", "")), ["branch:feat/a"]);
  assert.deepEqual(kv(artifactsFromBash("git push --force-with-lease origin +local:remote-b", "")), [
    "branch:remote-b",
  ]);
  assert.deepEqual(kv(artifactsFromBash("git push", "")), []);
  assert.deepEqual(kv(artifactsFromBash("git push origin --delete old", "")), []);
  assert.deepEqual(kv(artifactsFromBash("git push origin refs/tags/v1.0", "")), []);
  assert.deepEqual(kv(artifactsFromBash("git push --tags", "")), []);
  const shortUpdate = "To github.com:o/r.git\n   1a2b3c4..5d6e7f8  main -> main";
  assert.deepEqual(kv(artifactsFromBash("git push", shortUpdate)), ["branch:main"], "short SHAs are not commits");
  const fullUpdate = `To github.com:o/r.git\n + ${SHA2}...${SHA} feat -> feat (forced update)`;
  assert.deepEqual(kv(artifactsFromBash("git push -f", fullUpdate)), ["branch:feat", `commit:${SHA}`]);
});

test("git fetch output is not read as a push", () => {
  const fetchOut = "From github.com:o/r\n * [new branch]      other -> origin/other";
  assert.deepEqual(kv(artifactsFromBash("git fetch origin", fetchOut)), []);
});

test("checkout -b, switch -c and gh pr create --head name the branch", () => {
  assert.deepEqual(kv(artifactsFromBash("git checkout -b fix/one", "Switched to a new branch 'fix/one'")), [
    "branch:fix/one",
  ]);
  assert.deepEqual(kv(artifactsFromBash("git switch -c fix/two", "")), ["branch:fix/two"]);
  assert.deepEqual(kv(artifactsFromBash("git checkout main", "")), []);
  assert.deepEqual(
    kv(
      artifactsFromBash(
        "gh pr create --head=me:fix/three --base main --title 'T' --body-file b.md",
        "https://github.com/o/r/pull/12\n",
      ),
    ),
    ["branch:fix/three", "pr:https://github.com/o/r/pull/12"],
  );
});

test("commit only from git rev-parse HEAD output, full SHA only", () => {
  assert.deepEqual(kv(artifactsFromBash("git rev-parse HEAD", `${SHA}\n`)), [`commit:${SHA}`]);
  assert.deepEqual(kv(artifactsFromBash("git rev-parse --short HEAD", "0123456\n")), []);
  assert.deepEqual(kv(artifactsFromBash("git log -1", `commit ${SHA}\n`)), []);
  assert.deepEqual(kv(artifactsFromBash("cat sha.txt", `${SHA}\n`)), []);
});

test("PR URLs: gh pr create output and the final text, not other commands", () => {
  assert.deepEqual(kv(artifactsFromBash("gh pr view 12 --json url", '{"url":"https://github.com/o/r/pull/12"}')), []);
  const fromText = artifactsFromResultText("Opened https://github.com/o/r/pull/12. Commit deadbee, see #12.");
  assert.deepEqual(fromText, [{ kind: "pr", value: "https://github.com/o/r/pull/12", source: "result_text" }]);
  assert.deepEqual(artifactsFromResultText("Fixed in abc1234 and cafe; nothing else."), []);
  assert.deepEqual(artifactsFromResultText(null), []);
});

test("uniqueArtifacts keeps the first finding of each kind and value", () => {
  const all = uniqueArtifacts([
    ...artifactsFromBash("gh pr create --head b", "https://github.com/o/r/pull/3"),
    ...artifactsFromBash("git push origin b", ""),
    ...artifactsFromResultText("PR: https://github.com/o/r/pull/3"),
  ]);
  assert.deepEqual(
    all.map((f) => `${f.kind}:${f.value}:${f.source}`),
    ["branch:b:tool_result", "pr:https://github.com/o/r/pull/3:tool_result"],
  );
});

test("the parser emits bash_result with the command, and the subagent that ran it", () => {
  const state = createStreamState();
  const lines = [
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git rev-parse HEAD" } }] },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `${SHA}\n` }] } },
    {
      type: "assistant",
      agent_id: "a1",
      parent_tool_use_id: "t_agent",
      message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "git push" } }] },
    },
    {
      type: "user",
      agent_id: "a1",
      parent_tool_use_id: "t_agent",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "done" }] }] },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Read", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: SHA }] } },
  ];
  const results = lines.flatMap((o) => ingestLine(state, JSON.stringify(o))).filter((e) => e.type === "bash_result");
  assert.deepEqual(results, [
    { type: "bash_result", command: "git rev-parse HEAD", output: `${SHA}\n`, agentId: null },
    { type: "bash_result", command: "git push", output: "done", agentId: "a1" },
  ]);
  assert.equal(state.bashCalls.size, 0, "answered calls are forgotten");
});
