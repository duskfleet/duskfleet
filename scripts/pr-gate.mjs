#!/usr/bin/env node
// Keeps the review flow (docs/development.md "Issue and review flow by agents") honest about
// the merge state of its pull requests. A PR labelled `flow: needs-review` or
// `flow: ready-to-merge` was good when it got the label; once `main` moves it can conflict,
// and a red required check can appear after a re-run. Nobody in the flow looks at either, so
// such a PR waited for a human to notice. This script does the looking, deterministically and
// without an LLM, and hands the PR back to the developer agent through the labels it already
// understands:
//
//   - conflicts with its base, or a required check failed on its head
//       → one `[pr-gate]` comment naming the head SHA and the reasons, then the label
//         `flow: changes-requested` replaces the gating label (the developer agent picks it up
//         on its next tick, exactly as after a review);
//   - behind its base but clean (the ruleset on main requires an up-to-date branch)
//       → with --update-branch, GitHub's update-branch merges the base into the PR branch,
//         no agent involved. Only run it with a token whose pushes trigger CI (a user token,
//         never the workflow's GITHUB_TOKEN: a push made with it starts no workflow).
//
// Idempotent: a PR whose current head already carries a `[pr-gate]` comment is left alone,
// whatever its labels (a human may have overruled the gate). PRs in any other flow state
// (`in-review`, `in-progress`, `needs-human`, unlabelled), drafts and Dependabot PRs are never
// touched. Run from the repository (gh resolves {owner}/{repo}).
//
//   node scripts/pr-gate.mjs [--dry-run] [--update-branch]
import { execFileSync } from "node:child_process";

const GATED_LABELS = ["flow: needs-review", "flow: ready-to-merge"];
const HANDOFF_LABEL = "flow: changes-requested";
const MARKER = "[pr-gate]";
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ERROR"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const updateBranch = args.includes("--update-branch");

function gh(ghArgs, { input } = {}) {
  return execFileSync("gh", ghArgs, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const prs = JSON.parse(
  gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,isDraft,author,labels,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup",
  ]),
);

// GitHub computes `mergeable` lazily: the first read after a push to the base says UNKNOWN.
// Re-read the PR until it is known (a few seconds), then give up on that PR for this run.
function mergeState(pr) {
  let { mergeable, mergeStateStatus } = pr;
  for (let attempt = 0; mergeable === "UNKNOWN" && attempt < 8; attempt++) {
    sleep(3000);
    const fresh = JSON.parse(gh(["api", `repos/{owner}/{repo}/pulls/${pr.number}`]));
    if (fresh.mergeable === true) mergeable = "MERGEABLE";
    else if (fresh.mergeable === false) mergeable = "CONFLICTING";
    mergeStateStatus = (fresh.mergeable_state ?? "unknown").toUpperCase();
  }
  return { mergeable, mergeStateStatus };
}

// Reasons a PR cannot go on: each is one line of the hand-off comment.
function reasons(pr, mergeable) {
  const out = [];
  if (mergeable === "CONFLICTING") {
    out.push(`conflicts with ${pr.baseRefName}: merge origin/${pr.baseRefName} into ${pr.headRefName} and resolve`);
  }
  for (const check of pr.statusCheckRollup ?? []) {
    const name = check.name ?? check.context ?? "check";
    const conclusion = (check.conclusion ?? check.state ?? "").toUpperCase();
    if (!FAILED_CONCLUSIONS.has(conclusion)) continue;
    const url = check.detailsUrl ?? check.targetUrl ?? "";
    out.push(`check "${name}" ${conclusion.toLowerCase().replace("_", " ")}${url ? `: ${url}` : ""}`);
  }
  return out;
}

function alreadyHanded(pr) {
  const comments = JSON.parse(gh(["api", "--paginate", `repos/{owner}/{repo}/issues/${pr.number}/comments`]));
  return comments.some((c) => c.body?.startsWith(MARKER) && c.body.includes(`head ${pr.headRefOid}`));
}

const summary = { handed: 0, updated: 0, clean: 0, skipped: 0 };
for (const pr of prs) {
  const labels = pr.labels.map((label) => label.name);
  const gating = labels.find((name) => GATED_LABELS.includes(name));
  if (pr.isDraft || !gating || pr.headRefName.startsWith("dependabot/")) {
    summary.skipped++;
    continue;
  }
  const { mergeable, mergeStateStatus } = mergeState(pr);
  if (mergeable === "UNKNOWN") {
    console.log(`PR #${pr.number}: merge state still unknown, next run`);
    summary.skipped++;
    continue;
  }

  const why = reasons(pr, mergeable);
  if (why.length === 0) {
    if (updateBranch && mergeStateStatus === "BEHIND") {
      console.log(`PR #${pr.number}: behind ${pr.baseRefName}, updating the branch`);
      summary.updated++;
      if (!dryRun) gh(["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr.number}/update-branch`]);
    } else {
      summary.clean++;
    }
    continue;
  }

  if (alreadyHanded(pr)) {
    console.log(`PR #${pr.number}: head ${pr.headRefOid.slice(0, 7)} already handed back, left alone`);
    summary.skipped++;
    continue;
  }
  console.log(`PR #${pr.number}: ${gating} -> ${HANDOFF_LABEL}`);
  for (const line of why) console.log(`  - ${line}`);
  summary.handed++;
  if (dryRun) continue;

  const body = [
    `${MARKER} Rework needed before review or merge, head ${pr.headRefOid}:`,
    ...why.map((line) => `- ${line}`),
    "",
    `Handed to the developer with ${HANDOFF_LABEL} (docs/development.md, "Issue and review flow by agents").`,
  ].join("\n");
  gh(["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr.number}/comments`, "-f", `body=${body}`]);
  gh(["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr.number}/labels`, "-f", `labels[]=${HANDOFF_LABEL}`]);
  gh(["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/${pr.number}/labels/${encodeURIComponent(gating)}`]);
}

console.log(
  `pr-gate${dryRun ? " (dry run)" : ""}: ${summary.handed} handed back, ${summary.updated} updated, ${summary.clean} clean, ${summary.skipped} not gated`,
);
