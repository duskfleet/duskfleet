// Pure Dependabot decisions: no GitHub calls are made when importing pr-gate.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpLevel,
  dependabotAction,
  dependabotBumps,
  dependabotDecision,
  dependabotNextStep,
  headVerdict,
  isDependabotPr,
} from "./pr-gate.mjs";

const SHA = "a".repeat(40);
const REVIEWER = "geberele";
const OWNER = "duskfleet";
const approve = [{ user: { login: REVIEWER }, created_at: "2026-11-01T00:00:00Z", body: `Reviewed ${SHA}\n\nVERDICT: approve` }];

function pr(overrides = {}) {
  return {
    isDraft: false,
    author: { login: "dependabot[bot]" },
    isCrossRepository: false,
    headRepositoryOwner: { login: OWNER },
    headRefName: "dependabot/npm_and_yarn/biomejs/biome-2.6.4",
    headRefOid: SHA,
    title: "Bump @biomejs/biome from 2.6.2 to 2.6.4",
    body: "Updates `@biomejs/biome` from 2.6.2 to 2.6.4\n\nRelease notes",
    labels: [{ name: "flow: ready-to-merge" }],
    ...overrides,
  };
}

function decision(p, comments = approve) {
  return dependabotDecision(p, {
    verdict: headVerdict(comments, { headSha: p.headRefOid, login: REVIEWER }),
    repositoryOwner: OWNER,
  });
}

test("a reviewed patch bump qualifies for auto-merge", () => {
  assert.equal(decision(pr()).action, "merge");
});

test("minor bumps qualify; major bumps stay with the owner", () => {
  assert.equal(decision(pr({ title: "Bump vitest from 3.2.4 to 3.3.0" })).action, "merge");
  assert.equal(decision(pr({ title: "Bump typescript from 5.9.3 to 6.0.1" })).action, "owner");
});

test("every bump in a group must be safe and the announced count must match", () => {
  const group = pr({
    title: "Bump the npm-minor group with 2 updates",
    body: "Updates `vitest` from 3.2.4 to 3.3.0\nUpdates `zod` from 4.1.1 to 4.1.2",
  });
  assert.equal(decision(group).action, "merge");
  assert.equal(decision({ ...group, body: group.body.replace("zod` from 4.1.1 to 4.1.2", "typescript` from 5.9.3 to 6.0.1") }).action, "owner");
  assert.equal(decision({ ...group, body: "Updates `vitest` from 3.2.4 to 3.3.0" }).action, "owner");
});

test("only a current-head verdict from the authenticated reviewer is trusted", () => {
  const stale = [{ ...approve[0], body: `Reviewed ${"b".repeat(40)}\n\nVERDICT: approve` }];
  const otherUser = [{ ...approve[0], user: { login: "someone-else" } }];
  const quoted = [{ ...approve[0], body: `I would write VERDICT: approve here\nReviewed ${SHA}` }];
  assert.equal(decision(pr(), stale).action, "skip");
  assert.equal(decision(pr(), otherUser).action, "skip");
  assert.equal(decision(pr(), quoted).action, "skip");
  assert.equal(headVerdict(approve, { headSha: SHA, login: null }), null);
});

test("the latest comment and its last verdict line decide", () => {
  const laterChanges = [...approve, { ...approve[0], created_at: "2026-11-02T00:00:00Z", body: `Reviewed ${SHA}\n\nVERDICT: changes` }];
  assert.equal(decision(pr(), laterChanges).action, "skip");
  const lastLine = [{ ...approve[0], body: `Reviewed ${SHA}\n\nVERDICT: changes\nVERDICT: approve` }];
  assert.equal(decision(pr(), lastLine).action, "merge");
});

test("Dependabot must be the actual author and the head must belong to this repository", () => {
  assert.equal(isDependabotPr(pr(), OWNER), true);
  assert.equal(decision(pr({ author: { login: "attacker" } })).action, "skip");
  assert.equal(decision(pr({ isCrossRepository: true })).action, "skip");
  assert.equal(decision(pr({ headRepositoryOwner: { login: "attacker" } })).action, "skip");
  assert.equal(isDependabotPr(pr(), "another-owner"), false);
  assert.equal(decision(pr({ author: { login: "app/dependabot" } })).action, "skip");
});

test("drafts, wrong branches and missing ready labels are skipped", () => {
  assert.equal(decision(pr({ isDraft: true })).action, "skip");
  assert.equal(decision(pr({ headRefName: "issue/355-auto-merge" })).action, "skip");
  assert.equal(decision(pr({ labels: [{ name: "flow: needs-review" }] })).action, "skip");
});

test("0.x minor changes are major; SemVer inputs must be complete and valid", () => {
  assert.equal(bumpLevel("0.4.2", "0.5.0"), "major");
  assert.equal(bumpLevel("0.4.2", "0.4.3"), "patch");
  assert.equal(bumpLevel("1.4.2", "1.5.0"), "minor");
  assert.equal(bumpLevel("1.2", "1.2.1"), "unknown");
  assert.equal(bumpLevel("1.02.0", "1.2.1"), "unknown");
  assert.equal(bumpLevel("1.2.0-beta.1", "1.2.0+build.2"), "patch");
});

test("a branch update is an independent action and dry-run must not imply unavailable writes", () => {
  assert.equal(dependabotNextStep("BEHIND"), "update");
  assert.equal(dependabotNextStep("CLEAN"), "merge");
  assert.equal(dependabotAction("BEHIND", false), "skip");
  assert.equal(dependabotAction("BEHIND", true), "update");
  assert.equal(dependabotAction("CLEAN", false), "skip");
  assert.equal(dependabotAction("CLEAN", true), "merge");
});

test("single and grouped bump formats are parsed, including directory suffixes and markdown", () => {
  assert.deepEqual(dependabotBumps("Bump zod from 4.1.1 to 4.1.2", ""), [{ name: "zod", from: "4.1.1", to: "4.1.2" }]);
  assert.deepEqual(
    dependabotBumps("Bump eslint from 0.4.2 to 0.5.0 in /apps/web", ""),
    [{ name: "eslint", from: "0.4.2", to: "0.5.0" }],
  );
  assert.deepEqual(
    dependabotBumps("Bump the npm group", "Bumps [eslint](https://github.com/npm/eslint) from 0.4.2 to 0.4.3"),
    [{ name: "eslint", from: "0.4.2", to: "0.4.3" }],
  );
  assert.equal(decision(pr({ title: "Bump the npm group", body: "" })).action, "owner");
  assert.equal(decision(pr({ title: "Bump foo from latest to 2.0.0", body: "" })).action, "owner");
});
