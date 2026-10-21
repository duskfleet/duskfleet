#!/usr/bin/env node
// Keeps the review flow (docs/development.md "Issue and review flow by agents") honest about
// the merge state of its pull requests. A PR labelled `flow: needs-review` or
// `flow: ready-to-merge` was good when it got the label; once `main` moves it can conflict,
// and a red required check can appear after a re-run. Nobody in the flow looks at either, so
// such a PR waited for a human to notice. This script does the looking, deterministically and
// without an LLM, and hands the PR back to the developer agent through the labels it already
// understands:
//
//   - conflicts with its base, or a required check (from the rulesets on the base) failed on
//     its head
//       → the label `flow: changes-requested` replaces the gating label (the developer agent
//         picks it up on its next tick, exactly as after a review), then one `[pr-gate]`
//         comment names the head SHA and the reasons;
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

// The status checks the rulesets on a base branch require (the `checks` job on main). Only
// those block a merge: a failed non-required job (the project sync, a third-party status) must
// not bounce a mergeable PR. Cached per base; null when the rules cannot be read.
const requiredByBase = new Map();
function requiredChecks(base) {
  if (!requiredByBase.has(base)) {
    let names = null;
    try {
      const rules = JSON.parse(
        gh(["api", "--paginate", `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(base)}`]),
      );
      names = new Set(
        rules
          .filter((rule) => rule.type === "required_status_checks")
          .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
          .map((check) => check.context),
      );
    } catch (error) {
      console.log(
        `rules of ${base} unreadable (${error.message.split("\n")[0]}), counting failed checks only when blocked`,
      );
    }
    requiredByBase.set(base, names);
  }
  return requiredByBase.get(base);
}

// Reasons a PR cannot go on: each is one line of the hand-off comment.
function reasons(pr, mergeable, mergeStateStatus) {
  const out = [];
  if (mergeable === "CONFLICTING") {
    out.push(`conflicts with ${pr.baseRefName}: merge origin/${pr.baseRefName} into ${pr.headRefName} and resolve`);
  }
  const required = requiredChecks(pr.baseRefName);
  // Without readable rules, a failure counts only when GitHub says the merge is blocked.
  if (!required && mergeStateStatus !== "BLOCKED") return out;
  for (const check of pr.statusCheckRollup ?? []) {
    const name = check.name ?? check.context ?? "check";
    if (required && !required.has(name)) continue;
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

// One PR; returns the summary bucket it falls in. Throws on a failed gh call.
function gate(pr) {
  const labels = pr.labels.map((label) => label.name);
  const gating = labels.find((name) => GATED_LABELS.includes(name));
  if (pr.isDraft || !gating || pr.headRefName.startsWith("dependabot/")) return "skipped";
  const { mergeable, mergeStateStatus } = mergeState(pr);
  if (mergeable === "UNKNOWN") {
    console.log(`PR #${pr.number}: merge state still unknown, next run`);
    return "skipped";
  }

  const why = reasons(pr, mergeable, mergeStateStatus);
  if (why.length === 0) {
    if (!updateBranch || mergeStateStatus !== "BEHIND") return "clean";
    console.log(`PR #${pr.number}: behind ${pr.baseRefName}, updating the branch`);
    if (!dryRun) gh(["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr.number}/update-branch`]);
    return "updated";
  }

  if (alreadyHanded(pr)) {
    console.log(`PR #${pr.number}: head ${pr.headRefOid.slice(0, 7)} already handed back, left alone`);
    return "skipped";
  }
  console.log(`PR #${pr.number}: ${gating} -> ${HANDOFF_LABEL}`);
  for (const line of why) console.log(`  - ${line}`);
  if (dryRun) return "handed";

  // Labels first, marker comment last: the comment is what makes the hand-off idempotent, so
  // it must exist only once the labels moved. A failed label call leaves no marker, and the
  // next run retries the whole hand-off.
  gh(["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr.number}/labels`, "-f", `labels[]=${HANDOFF_LABEL}`]);
  gh(["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/${pr.number}/labels/${encodeURIComponent(gating)}`]);
  const body = [
    `${MARKER} Rework needed before review or merge, head ${pr.headRefOid}:`,
    ...why.map((line) => `- ${line}`),
    "",
    `Handed to the developer with ${HANDOFF_LABEL} (docs/development.md, "Issue and review flow by agents").`,
  ].join("\n");
  gh(["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr.number}/comments`, "-f", `body=${body}`]);
  return "handed";
}

// One failing PR (an update-branch 422 after the PR turned conflicting, a 5xx) must not skip
// the others: log it, go on, and exit non-zero at the end.
const summary = { handed: 0, updated: 0, clean: 0, skipped: 0, failed: 0 };
for (const pr of prs) {
  try {
    summary[gate(pr)]++;
  } catch (error) {
    console.error(`PR #${pr.number}: failed: ${(error.stderr || error.message).toString().trim()}`);
    summary.failed++;
  }
}

console.log(
  `pr-gate${dryRun ? " (dry run)" : ""}: ${summary.handed} handed back, ${summary.updated} updated, ${summary.clean} clean, ${summary.skipped} not gated, ${summary.failed} failed`,
);
if (summary.failed > 0) process.exitCode = 1;
