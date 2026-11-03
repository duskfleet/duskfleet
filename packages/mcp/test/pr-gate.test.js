// scripts/pr-gate.mjs: the selection of the closed-item cleanup pass (#359). Pure, no gh call:
// importing the script runs nothing, main() only runs when it is executed directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpLevel,
  bumpScope,
  closedFlowLabels,
  dependabotDecision,
  headVerdict,
  isDependabotPr,
} from "../../../scripts/pr-gate.mjs";

const now = Date.parse("2026-11-03T12:00:00Z");
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();
const labels = (...names) => names.map((name) => ({ name }));

test("a closed issue loses every flow label and keeps area and priority", () => {
  const issue = {
    number: 1,
    state: "closed",
    closed_at: daysAgo(1),
    labels: labels("area: tests", "flow: in-progress", "priority: low", "flow: needs-human"),
  };
  assert.deepEqual(closedFlowLabels(issue, { now }), ["flow: in-progress", "flow: needs-human"]);
});

test("a merged PR loses its review labels", () => {
  const pr = {
    number: 2,
    state: "closed",
    closed_at: daysAgo(0.1),
    pull_request: { merged_at: daysAgo(0.1) },
    labels: labels("flow: ready-to-merge", "dependencies"),
  };
  assert.deepEqual(closedFlowLabels(pr, { now }), ["flow: ready-to-merge"]);
});

test("a PR closed without a merge is cleared too", () => {
  const pr = {
    number: 3,
    state: "closed",
    closed_at: daysAgo(2),
    pull_request: { merged_at: null },
    labels: labels("flow: changes-requested", "flow: in-review"),
  };
  assert.deepEqual(closedFlowLabels(pr, { now }), ["flow: changes-requested", "flow: in-review"]);
});

test("open items are never touched", () => {
  const issue = { number: 4, state: "open", closed_at: null, labels: labels("flow: in-progress") };
  assert.deepEqual(closedFlowLabels(issue, { now }), []);
});

test("items closed more than 30 days ago are left alone", () => {
  const issue = { number: 5, state: "closed", closed_at: daysAgo(31), labels: labels("flow: ready") };
  assert.deepEqual(closedFlowLabels(issue, { now }), []);
  assert.deepEqual(closedFlowLabels(issue, { now, days: 40 }), ["flow: ready"]);
});

test("a closed item without flow labels, or without a close date, needs nothing", () => {
  assert.deepEqual(
    closedFlowLabels({ number: 6, state: "closed", closed_at: daysAgo(1), labels: labels("area: web") }, { now }),
    [],
  );
  assert.deepEqual(
    closedFlowLabels({ number: 7, state: "closed", closed_at: null, labels: labels("flow: ready") }, { now }),
    [],
  );
});

test("a label prefix match is exact: no flow-like names", () => {
  const issue = {
    number: 8,
    state: "closed",
    closed_at: daysAgo(1),
    labels: [{ name: "workflow: ci" }, { name: "flow:ready" }, "flow: needs-review"],
  };
  assert.deepEqual(closedFlowLabels(issue, { now }), ["flow: needs-review"]);
});

// --- Dependabot auto-merge (#355): the candidate filter ---

const HEAD = "288c4055e3055667d2d0890c94b2f14db39e60b3";
const OLD = "1111111111111111111111111111111111111111";
const ME = "maintainer";
const dependabotPr = (over = {}) => ({
  number: 338,
  title: "Build(deps-dev): Bump @biomejs/biome from 2.6.2 to 2.6.4 in the dev-tooling group across 1 directory",
  body: "Bumps the dev-tooling group with 1 update in the / directory: [@biomejs/biome](https://x).\n\nUpdates `@biomejs/biome` from 2.6.2 to 2.6.4\n<details>\n",
  author: { login: "app/dependabot", is_bot: true },
  isCrossRepository: false,
  headRefName: "dependabot/npm_and_yarn/dev-tooling-bf25c66ca4",
  headRefOid: HEAD,
  labels: labels("flow: ready-to-merge", "dependencies"),
  ...over,
});
const reviewComment = (sha, verdictLines, over = {}) => ({
  user: { login: ME },
  created_at: "2026-11-03T10:00:00Z",
  body: `Reviewed ${sha}\nChecks pass.\n${verdictLines}`,
  ...over,
});

test("bumpLevel: patch, minor, major, with 0.x breaking changes one place right", () => {
  assert.equal(bumpLevel("2.6.2", "2.6.4"), "patch");
  assert.equal(bumpLevel("1.32.1", "1.33.0"), "minor");
  assert.equal(bumpLevel("24.19.1", "26.6.5"), "major");
  assert.equal(bumpLevel("4", "7"), "major");
  assert.equal(bumpLevel("v1.2.3", "v1.2.4"), "patch");
  assert.equal(bumpLevel("0.4.2", "0.5.0"), "major");
  assert.equal(bumpLevel("0.4.2", "0.4.3"), "patch");
  assert.equal(bumpLevel("0.0.1", "0.0.2"), "major");
  assert.equal(bumpLevel("3d3c42e", "949feb2"), "unknown");
  assert.equal(bumpLevel("2.0.0-beta.1", "2.0.0"), "unknown");
});

test("bumpScope: single bump with an 'in the group' tail and an 'in /dir' tail", () => {
  assert.deepEqual(bumpScope(dependabotPr().title, dependabotPr().body), {
    ok: true,
    reason: "",
    bumps: [{ name: "@biomejs/biome", from: "2.6.2", to: "2.6.4" }],
  });
  const inDir = bumpScope("Bump next from 15.1.2 to 15.1.3 in /apps/web", "");
  assert.equal(inDir.ok, true);
  assert.deepEqual(inDir.bumps, [{ name: "next", from: "15.1.2", to: "15.1.3" }]);
});

test("bumpScope: the single-package 'Bumps [x](url) from' body counts, a major refuses", () => {
  const body = "Bumps [actions/checkout](https://github.com/actions/checkout) from 4 to 7.\n<details>";
  const scope = bumpScope("build(deps): Bump actions/checkout from 4 to 7", body);
  assert.equal(scope.ok, false);
  assert.match(scope.reason, /actions\/checkout 4 to 7 is a major bump/);
  const minor = bumpScope("chore: update", "Bumps [zod](https://x) from 4.1.0 to 4.2.1.\n");
  assert.equal(minor.ok, true);
  assert.deepEqual(minor.bumps, [{ name: "zod", from: "4.1.0", to: "4.2.1" }]);
});

test("bumpScope: a group qualifies only when every listed bump is patch or minor and the count matches", () => {
  const title = "Build(deps): Bump the runtime group across 1 directory with 2 updates";
  const ok = bumpScope(title, "Updates `zod` from 4.1.0 to 4.1.2\n\nUpdates `yaml` from 2.8.0 to 2.9.0\n");
  assert.equal(ok.ok, true);
  assert.equal(ok.bumps.length, 2);
  const major = bumpScope(title, "Updates `zod` from 4.1.0 to 4.1.2\nUpdates `typescript` from 5.9.3 to 7.0.2\n");
  assert.equal(major.ok, false);
  assert.match(major.reason, /typescript 5\.9\.3 to 7\.0\.2 is a major/);
  const short = bumpScope(title, "Updates `zod` from 4.1.0 to 4.1.2\n");
  assert.equal(short.ok, false);
  assert.match(short.reason, /announces 2 updates, the body lists 1/);
});

test("bumpScope: nothing parsable stays for the owner", () => {
  const scope = bumpScope("Build(deps): something else", "no versions here");
  assert.equal(scope.ok, false);
  assert.match(scope.reason, /no version bump found/);
});

test("isDependabotPr: author, branch and same repository, all three", () => {
  assert.equal(isDependabotPr(dependabotPr()), true);
  assert.equal(isDependabotPr(dependabotPr({ author: { login: "dependabot[bot]" } })), true);
  assert.equal(isDependabotPr(dependabotPr({ author: { login: "someone" } })), false);
  assert.equal(isDependabotPr(dependabotPr({ isCrossRepository: true })), false);
  assert.equal(isDependabotPr(dependabotPr({ headRefName: "issue/1-x" })), false);
});

test("headVerdict: only the gate's own account, only Reviewed <head sha>, newest comment, last line", () => {
  const opts = { headSha: HEAD, login: ME };
  assert.equal(headVerdict([reviewComment(HEAD, "VERDICT: approve")], opts), "approve");
  // Someone else's comment with the right shape does not count.
  assert.equal(headVerdict([reviewComment(HEAD, "VERDICT: approve", { user: { login: "stranger" } })], opts), null);
  // A verdict for an older head does not count for the current one.
  assert.equal(headVerdict([reviewComment(OLD, "VERDICT: approve")], opts), null);
  // The SHA must be on the first line, as the reviewer writes it; a mention further down is not a review.
  assert.equal(
    headVerdict(
      [{ user: { login: ME }, created_at: "2026-11-03T10:00:00Z", body: `Note on ${HEAD}\nVERDICT: approve` }],
      opts,
    ),
    null,
  );
  // The last VERDICT line of a comment decides, not the first (a quoted earlier round).
  assert.equal(
    headVerdict([reviewComment(HEAD, "Earlier: \nVERDICT: changes\nNow fixed.\nVERDICT: approve")], opts),
    "approve",
  );
  assert.equal(headVerdict([reviewComment(HEAD, "VERDICT: approve\nbut then\nVERDICT: changes")], opts), "changes");
  // The newest review of the head decides.
  const older = reviewComment(HEAD, "VERDICT: approve", { created_at: "2026-11-03T09:00:00Z" });
  const newer = reviewComment(HEAD, "VERDICT: changes", { created_at: "2026-11-03T11:00:00Z" });
  assert.equal(headVerdict([newer, older], opts), "changes");
  // A mid-line quote is not a verdict.
  assert.equal(headVerdict([reviewComment(HEAD, "the old VERDICT: approve is void")], opts), null);
  // No login (an app token) trusts nobody.
  assert.equal(headVerdict([reviewComment(HEAD, "VERDICT: approve")], { headSha: HEAD, login: null }), null);
});

test("dependabotDecision: merge only with label, author, approval and a patch/minor scope", () => {
  assert.equal(dependabotDecision(dependabotPr(), { verdict: "approve" }).action, "merge");
  assert.deepEqual(dependabotDecision(dependabotPr({ labels: labels("flow: needs-review") }), { verdict: "approve" }), {
    action: "skip",
    why: "not labelled flow: ready-to-merge",
  });
  assert.equal(dependabotDecision(dependabotPr(), { verdict: "changes" }).action, "skip");
  assert.equal(dependabotDecision(dependabotPr(), { verdict: null }).action, "skip");
  assert.equal(dependabotDecision(dependabotPr({ isCrossRepository: true }), { verdict: "approve" }).action, "skip");
  const major = dependabotPr({
    title: "build(deps): Bump actions/checkout from 4 to 7",
    body: "Bumps [actions/checkout](https://github.com/actions/checkout) from 4 to 7.",
  });
  assert.deepEqual(dependabotDecision(major, { verdict: "approve" }), {
    action: "owner",
    why: "actions/checkout 4 to 7 is a major bump",
  });
});
