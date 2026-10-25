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
// A PR from a fork (a contributor's) is handed back with `flow: contributor-changes` instead:
// the developer agent cannot push to a fork, so that label is the contributor's to answer and
// no agent picks it. Once the contributor pushes a commit after the label, the gate moves the
// PR back to `flow: needs-review` for the next review round.
//
// Idempotent: a PR whose current head already carries a `[pr-gate]` comment is left alone,
// whatever its labels (a human may have overruled the gate). Drafts and Dependabot PRs are
// never touched. Run from the repository (gh resolves {owner}/{repo}).
//
// The gate also expires stale locks. `flow: in-progress` and `flow: in-review` are the labels
// an agent swaps in first, as a lock against a second run; a run that then dies (timeout,
// killed child, a "tests are running, I'll pick up later" ending) leaves the lock behind,
// every later run skips the item as someone else's, and nothing in the flow looks at it
// again (PR #164 sat in-progress for 17 h with no push, 2026-10-21). No run outlives its
// timeout (60 min at most), so a lock older than --stale-hours (default 2) with no activity
// since it was set is an orphan and goes back to the state it was taken from:
//
//   - PR `flow: in-progress`, no commit on the head since the label  → `flow: changes-requested`
//   - PR `flow: in-review`, no `VERDICT:` for its head since the label → `flow: needs-review`
//     (a verdict that was posted but never labelled gets its label instead, once stale too)
//   - issue `flow: in-progress` with no open PR closing it            → `flow: ready`
//
// each with a `[pr-gate]` comment naming the lock and its age. A new pickup is a new label
// event, so the clock restarts: a run that is still working is never interrupted.
//
//   node scripts/pr-gate.mjs [--dry-run] [--update-branch] [--stale-hours <n>]
import { execFileSync } from "node:child_process";

const GATED_LABELS = ["flow: needs-review", "flow: ready-to-merge"];
const HANDOFF_LABEL = "flow: changes-requested";
// The hand-off for a contributor's PR (from a fork): no agent can push to it, nobody picks it.
const CONTRIBUTOR_LABEL = "flow: contributor-changes";
const MARKER = "[pr-gate]";
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ERROR"]);
// Lock label → the state an orphaned one goes back to.
const PR_LOCKS = { "flow: in-progress": "flow: changes-requested", "flow: in-review": "flow: needs-review" };
const ISSUE_LOCKS = { "flow: in-progress": "flow: ready" };
const VERDICT_LABELS = { approve: "flow: ready-to-merge", changes: "flow: changes-requested" };
// Every keyword GitHub links a PR to an issue with (same as scripts/issue-plan.mjs).
const CLOSES = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)[ \t:]+((?:#\d+[ \t,;]*(?:and[ \t]+)?)+)/gi;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const updateBranch = args.includes("--update-branch");
const staleHoursArg = args.includes("--stale-hours") ? args[args.indexOf("--stale-hours") + 1] : "2";
const staleHours = Number(staleHoursArg);
if (!Number.isFinite(staleHours) || staleHours <= 0) {
  console.error(`--stale-hours needs a positive number of hours, got ${JSON.stringify(staleHoursArg)}`);
  process.exit(2);
}
const now = Date.now();

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
    "number,isDraft,author,labels,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,body,isCrossRepository",
  ]),
);

// The label that hands a PR back for rework: the developer's, or the contributor's for a fork.
function handoffLabel(pr, label = HANDOFF_LABEL) {
  return label === HANDOFF_LABEL && pr.isCrossRepository ? CONTRIBUTOR_LABEL : label;
}

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

function issueComments(number) {
  return JSON.parse(gh(["api", "--paginate", `repos/{owner}/{repo}/issues/${number}/comments`]));
}

function alreadyHanded(pr) {
  return issueComments(pr.number).some((c) => c.body?.startsWith(MARKER) && c.body.includes(`head ${pr.headRefOid}`));
}

function swapLabel(number, from, to) {
  gh(["api", "-X", "POST", `repos/{owner}/{repo}/issues/${number}/labels`, "-f", `labels[]=${to}`]);
  gh(["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/${number}/labels/${encodeURIComponent(from)}`]);
}

function comment(number, lines) {
  gh(["api", "-X", "POST", `repos/{owner}/{repo}/issues/${number}/comments`, "-f", `body=${lines.join("\n")}`]);
}

// When a lock label was last set on a PR or issue (its newest `labeled` event); null when the
// events do not say (a label created outside the API, or an unreadable timeline).
function lockedAt(number, label) {
  const events = JSON.parse(gh(["api", "--paginate", `repos/{owner}/{repo}/issues/${number}/events`]));
  const times = events
    .filter((event) => event.event === "labeled" && event.label?.name === label)
    .map((event) => Date.parse(event.created_at))
    .filter(Number.isFinite);
  return times.length === 0 ? null : Math.max(...times);
}

function hours(since) {
  return ((now - since) / 3_600_000).toFixed(1);
}

function isStale(since) {
  return now - since >= staleHours * 3_600_000;
}

// A PR lock older than --stale-hours with no activity since goes back to the state it was
// taken from. Returns the summary bucket, or null when the PR carries no lock label.
function expirePrLock(pr, labels) {
  const lock = labels.find((name) => name in PR_LOCKS);
  if (!lock) return null;
  const since = lockedAt(pr.number, lock);
  if (since === null) return "locked";
  let target = handoffLabel(pr, PR_LOCKS[lock]);
  let why;
  if (lock === "flow: in-progress") {
    // A push after the label is the developer at work; the clock runs from the last one.
    let activity = since;
    const commits = JSON.parse(
      gh(["pr", "view", String(pr.number), "--json", "commits", "--jq", "[.commits[].committedDate]"]),
    );
    for (const date of commits) activity = Math.max(activity, Date.parse(date) || 0);
    if (!isStale(activity)) return "locked";
    why = `no commit on ${pr.headRefName} for ${hours(activity)} h`;
  } else {
    // Age first: a live reviewer posts its VERDICT comment seconds before its own label swap,
    // and the gate must not race it.
    if (!isStale(since)) return "locked";
    // A VERDICT for the current head posted after the label: the review ended, only the
    // hand-off label is missing. Finish it instead of asking for a second review. The
    // VERDICT line must start a line, so a comment quoting it mid-sentence does not count.
    const verdict = issueComments(pr.number)
      .filter((c) => Date.parse(c.created_at) >= since && c.body?.includes(pr.headRefOid))
      .map((c) => /^VERDICT:\s*(approve|changes)\b/im.exec(c.body)?.[1]?.toLowerCase())
      .findLast(Boolean);
    if (verdict) {
      target = handoffLabel(pr, VERDICT_LABELS[verdict]);
      why = `VERDICT: ${verdict} for head ${pr.headRefOid.slice(0, 7)} was posted but never labelled`;
    } else {
      why = `no verdict for ${hours(since)} h`;
    }
  }
  console.log(`PR #${pr.number}: stale ${lock} (${why}) -> ${target}`);
  if (dryRun) return "expired";
  swapLabel(pr.number, lock, target);
  comment(pr.number, [
    `${MARKER} Stale lock: ${lock} since ${new Date(since).toISOString()}, ${why}. The run that took it is gone: no run outlives its timeout.`,
    "",
    `Back to ${target} so the next tick picks it up (docs/development.md, "Issue and review flow by agents").`,
  ]);
  return "expired";
}

// A contributor's PR handed back with `flow: contributor-changes` comes back for review once a
// commit lands on its head after the label: the contributor answered. Returns the summary
// bucket, or null when the PR does not carry the label.
function reviveContributorPr(pr, labels) {
  if (!labels.includes(CONTRIBUTOR_LABEL)) return null;
  const since = lockedAt(pr.number, CONTRIBUTOR_LABEL);
  if (since === null) return "waiting";
  const commits = JSON.parse(
    gh(["pr", "view", String(pr.number), "--json", "commits", "--jq", "[.commits[].committedDate]"]),
  );
  if (!commits.some((date) => (Date.parse(date) || 0) > since)) return "waiting";
  console.log(`PR #${pr.number}: new commits since ${CONTRIBUTOR_LABEL} -> flow: needs-review`);
  if (dryRun) return "revived";
  swapLabel(pr.number, CONTRIBUTOR_LABEL, "flow: needs-review");
  comment(pr.number, [
    `${MARKER} New commits since the last review, head ${pr.headRefOid}: back to flow: needs-review for the next round (docs/development.md, "Issue and review flow by agents").`,
  ]);
  return "revived";
}

// An issue locked `flow: in-progress` whose developer never opened a PR goes back to the queue.
// An open PR closing it is the activity: from then on the PR's labels carry the state.
function expireIssueLock(issue, closedBy) {
  const lock = issue.labels.map((label) => label.name).find((name) => name in ISSUE_LOCKS);
  if (!lock) return "skipped";
  if (closedBy.has(issue.number)) return "locked";
  const since = lockedAt(issue.number, lock);
  if (since === null || !isStale(since)) return "locked";
  const target = ISSUE_LOCKS[lock];
  console.log(`issue #${issue.number}: stale ${lock} (no PR for ${hours(since)} h) -> ${target}`);
  if (dryRun) return "expired";
  swapLabel(issue.number, lock, target);
  comment(issue.number, [
    `${MARKER} Stale lock: ${lock} since ${new Date(since).toISOString()} and no open PR closes this issue. The run that took it is gone: no run outlives its timeout.`,
    "",
    `Back to ${target} so the next developer tick picks it up (docs/development.md, "Issue and review flow by agents").`,
  ]);
  return "expired";
}

// One PR; returns the summary bucket it falls in. Throws on a failed gh call.
function gate(pr) {
  const labels = pr.labels.map((label) => label.name);
  if (pr.isDraft || pr.headRefName.startsWith("dependabot/")) return "skipped";
  const locked = expirePrLock(pr, labels);
  if (locked) return locked;
  const revived = reviveContributorPr(pr, labels);
  if (revived) return revived;
  const gating = labels.find((name) => GATED_LABELS.includes(name));
  if (!gating) return "skipped";
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
  const handoff = handoffLabel(pr);
  console.log(`PR #${pr.number}: ${gating} -> ${handoff}`);
  for (const line of why) console.log(`  - ${line}`);
  if (dryRun) return "handed";

  // Labels first, marker comment last: the comment is what makes the hand-off idempotent, so
  // it must exist only once the labels moved. A failed label call leaves no marker, and the
  // next run retries the whole hand-off.
  swapLabel(pr.number, gating, handoff);
  comment(pr.number, [
    `${MARKER} Rework needed before review or merge, head ${pr.headRefOid}:`,
    ...why.map((line) => `- ${line}`),
    "",
    `Handed ${pr.isCrossRepository ? "back to the contributor" : "to the developer"} with ${handoff} (docs/development.md, "Issue and review flow by agents").`,
  ]);
  return "handed";
}

// One failing PR (an update-branch 422 after the PR turned conflicting, a 5xx) must not skip
// the others: log it, go on, and exit non-zero at the end.
const summary = {
  handed: 0,
  updated: 0,
  clean: 0,
  locked: 0,
  expired: 0,
  waiting: 0,
  revived: 0,
  skipped: 0,
  failed: 0,
};
for (const pr of prs) {
  try {
    summary[gate(pr)]++;
  } catch (error) {
    console.error(`PR #${pr.number}: failed: ${(error.stderr || error.message).toString().trim()}`);
    summary.failed++;
  }
}

// Issues the open PRs close (body keywords or an issue/<n>- branch, as in issue-plan.mjs).
const closedBy = new Set();
for (const pr of prs) {
  for (const match of (pr.body ?? "").matchAll(CLOSES)) {
    for (const ref of match[1].matchAll(/#(\d+)/g)) closedBy.add(Number(ref[1]));
  }
  const branchIssue = /^issue\/(\d+)-/.exec(pr.headRefName);
  if (branchIssue) closedBy.add(Number(branchIssue[1]));
}
let issues = [];
try {
  issues = JSON.parse(
    gh([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "flow: in-progress",
      "--limit",
      "200",
      "--json",
      "number,labels",
    ]),
  );
} catch (error) {
  console.error(`issues: failed: ${(error.stderr || error.message).toString().trim()}`);
  summary.failed++;
}
for (const issue of issues) {
  try {
    summary[expireIssueLock(issue, closedBy)]++;
  } catch (error) {
    console.error(`issue #${issue.number}: failed: ${(error.stderr || error.message).toString().trim()}`);
    summary.failed++;
  }
}

console.log(
  `pr-gate${dryRun ? " (dry run)" : ""}: ${summary.handed} handed back, ${summary.updated} updated, ${summary.clean} clean, ${summary.locked} locked and alive, ${summary.expired} stale locks expired, ${summary.waiting} waiting for a contributor, ${summary.revived} back for review, ${summary.skipped} not gated, ${summary.failed} failed`,
);
if (summary.failed > 0) process.exitCode = 1;
