#!/usr/bin/env node
// Keeps the review flow (docs/self-hosting-development.md "The PR gate") honest about
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
// whatever its labels (a human may have overruled the gate). Drafts are never touched, and
// Dependabot PRs never get the hand-off above. Run from the repository (gh resolves
// {owner}/{repo}).
//
// Dependabot PRs are the only ones that merge without the owner (owner decision 2026-11-03,
// issue #355). With --auto-merge (a user token: the code owner's, since the ruleset on main
// requires a code-owner review), a PR qualifies when all of these hold:
//
//   - author Dependabot, head branch `dependabot/...` in this repository (not a fork);
//   - labelled `flow: ready-to-merge`;
//   - the newest reviewer comment for its current head (first line `Reviewed <head sha>`,
//     posted by the token's own account) ends its last `VERDICT:` line with `approve`;
//   - every bump in the title and body is a semver patch or minor (on 0.x a minor is a major);
//     a grouped PR lists as many bumps as its title announces.
//
// Then the gate re-reads the head (an approval only ever lands on the reviewed SHA), approves
// that SHA, enables auto-merge (squash; the repository deletes merged branches) and, when the
// PR is behind its base, updates the branch: the approval survives that merge commit, since the
// ruleset does not dismiss stale reviews. The merge request carries --match-head-commit, so it
// binds to the reviewed SHA. One `[pr-gate]` comment per head says so. A PR that already has
// auto-merge on is re-verified every run (label, approval of its head or of the head an
// update-branch merge commit sits on, patch/minor scope) and kept up to date; when any of it
// fails, auto-merge is disabled with one `[pr-gate]` comment per head. A major or unparsable bump stays for the
// owner, with one `[pr-gate]` comment per head saying why. --dry-run lists the candidates and
// what a real run would do, after the same merge-state checks.
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
// Last, it clears the flow off finished work: a merged PR closes its issue through
// `Closes #n`, but nothing took the lock label off, so closed issues kept `flow: in-progress`
// on the board and in every label search. Every issue or PR closed (or merged) in the last
// CLEANUP_DAYS days loses all its `flow:` labels; `area:`, `priority:` and the rest stay, open
// items are never touched, and no comment is posted (--dry-run only lists them).
//
//   node scripts/pr-gate.mjs [--dry-run] [--update-branch] [--auto-merge] [--stale-hours <n>] [--repo <owner/name>]
//
// --repo (or GH_REPO) points every gh call at another repository, e.g. duskfleet/duskfleet-website.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
const FLOW_PREFIX = "flow: ";
// How far back the cleanup looks: older closed items were cleared by hand on 2026-11-02.
const CLEANUP_DAYS = 30;

// The `flow:` labels a closed issue or closed/merged PR (a REST issues item: `state`,
// `closed_at`, `labels`) must lose, or [] for an open item, one closed more than `days` ago,
// or one without flow labels. Pure: no gh call, so it is tested without network.
export function closedFlowLabels(item, { now, days = CLEANUP_DAYS }) {
  if (item.state !== "closed") return [];
  const closedAt = Date.parse(item.closed_at ?? "");
  if (!Number.isFinite(closedAt) || now - closedAt > days * 86_400_000) return [];
  return (item.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name.startsWith(FLOW_PREFIX));
}

// --- Dependabot auto-merge: pure parts, tested without network ---

const READY_LABEL = "flow: ready-to-merge";
const DEPENDABOT_LOGINS = new Set(["app/dependabot", "dependabot[bot]"]);

// A Dependabot PR by its author, its branch and its repository: a fork branch named
// `dependabot/x` with a forged title is someone else's PR.
export function isDependabotCandidate(pr) {
  return (
    !pr.isDraft &&
    DEPENDABOT_LOGINS.has(pr.author?.login ?? "") &&
    typeof pr.headRefName === "string" &&
    pr.headRefName.startsWith("dependabot/")
  );
}

export function isDependabotPr(pr, repositoryOwner) {
  return (
    isDependabotCandidate(pr) &&
    pr.isCrossRepository === false &&
    Boolean(repositoryOwner) &&
    pr.headRepositoryOwner?.login?.toLowerCase() === repositoryOwner.toLowerCase()
  );
}

const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// "patch", "minor", "major" or "unknown" (a SHA, pre-release, non-increasing or invalid version).
// Under the caret rule of npm, 0.x moves its breaking changes one place right: a 0.x minor and
// a 0.0.x patch count as major.
export function bumpLevel(from, to) {
  const a = VERSION.exec(from ?? "");
  const b = VERSION.exec(to ?? "");
  if (!a || !b) return "unknown";
  if (a[4] || b[4]) return "unknown";
  const [aMajor, aMinor, aPatch] = a.slice(1, 4).map(Number);
  const [bMajor, bMinor, bPatch] = b.slice(1, 4).map(Number);
  const comparison = [0, 1, 2].map((index) => b[index + 1] - a[index + 1]).find((delta) => delta !== 0) ?? 0;
  if (comparison <= 0) return "unknown";
  if (aMajor !== bMajor) return "major";
  if (aMajor === 0 && aMinor !== bMinor) return "major";
  if (aMajor === 0 && aMinor === 0 && aPatch !== bPatch) return "major";
  if (aMinor !== bMinor) return "minor";
  return "patch";
}

// Title forms: "Build(deps-dev): Bump x from 1.2.3 to 1.2.4", with an optional
// " in /apps/web" or " in the dev-tooling group across 1 directory" tail.
const TITLE_BUMP = /\bbump\s+(?!the\s)(\S+)\s+from\s+(\S+)\s+to\s+(\S+?)(?:\s+in\s+.*)?$/i;
// "Bump the runtime group across 1 directory with 5 updates".
const GROUP_TITLE = /\bbump\s+the\s+\S+\s+group\b.*\bwith\s+(\d+)\s+updates?\b/i;
// Body forms: one "Updates `x` from a to b" line per package of a group, or the single-package
// "Bumps [x](url) from a to b." sentence.
const BODY_UPDATES = /^Updates `([^`]+)` from (\S+) to (\S+?)\.?\s*$/gm;
const BODY_BUMPS = /^Bumps \[([^\]]+)\]\([^)]*\) from (\S+) to (\S+?)\.?\s*$/gm;

// Whether every bump the PR announces is patch or minor. Returns { ok, reason, bumps }; every
// bump found in the title or the body counts, so an extra one can only refuse, never allow.
export function bumpScope(title = "", body = "") {
  const updates = [...body.matchAll(BODY_UPDATES)];
  const found = [...updates, ...body.matchAll(BODY_BUMPS)];
  const titleBump = TITLE_BUMP.exec(title);
  if (titleBump) found.push(titleBump);
  const seen = new Map();
  for (const [, name, from, to] of found) seen.set(`${name} ${from} ${to}`, { name, from, to });
  const bumps = [...seen.values()];
  if (bumps.length === 0) return { ok: false, reason: "no version bump found in the title or body", bumps };
  const group = GROUP_TITLE.exec(title);
  const listed = new Set(updates.map(([, name, from, to]) => `${name} ${from} ${to}`)).size;
  if (group && listed !== Number(group[1])) {
    return { ok: false, reason: `the title announces ${group[1]} updates, the body lists ${listed}`, bumps };
  }
  for (const bump of bumps) {
    const level = bumpLevel(bump.from, bump.to);
    if (level !== "patch" && level !== "minor") {
      return { ok: false, reason: `${bump.name} ${bump.from} to ${bump.to} is a ${level} bump`, bumps };
    }
  }
  return { ok: true, reason: "", bumps };
}

// Expose the parsed version changes for focused tests and callers that need the detail.
export function dependabotBumps(title = "", body = "") {
  return bumpScope(title, body).bumps;
}

const REVIEWED = /^Reviewed\s+([0-9a-f]{40})\b/i;
const VERDICT_LINE = /^VERDICT:\s*(approve|changes)\b/gim;

// The reviewer's verdict on `headSha`, or null. Only comments by `login` (the account the gate
// acts as, which the reviewer agent posts with) whose first line is `Reviewed <headSha>` count;
// the newest of them decides, by its last `VERDICT:` line (a summary may quote an earlier one).
// `comments` are REST issue comments (`user.login`, `body`, `created_at`).
export function headVerdict(comments, { headSha, login }) {
  if (!headSha || !login) return null;
  const reviews = comments
    .filter((c) => c.user?.login === login)
    .filter((c) => REVIEWED.exec((c.body ?? "").trimStart())?.[1]?.toLowerCase() === headSha.toLowerCase())
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const latest = reviews.at(-1);
  if (!latest) return null;
  return [...latest.body.matchAll(VERDICT_LINE)].at(-1)?.[1]?.toLowerCase() ?? null;
}

// What the gate does with a Dependabot PR before any merge-state read: "skip" (not a candidate,
// `why` says which condition failed), "owner" (approved, but outside patch/minor: one comment,
// the owner merges) or "merge" (approve, auto-merge, keep current).
export function dependabotDecision(pr, { verdict, repositoryOwner }) {
  const labels = (pr.labels ?? []).map((label) => (typeof label === "string" ? label : label?.name));
  if (!isDependabotPr(pr, repositoryOwner))
    return { action: "skip", why: "not Dependabot's own branch in this repository" };
  if (!labels.includes(READY_LABEL)) return { action: "skip", why: `not labelled ${READY_LABEL}` };
  if (verdict !== "approve") return { action: "skip", why: "no reviewer approval for the current head" };
  const scope = bumpScope(pr.title, pr.body);
  if (!scope.ok) return { action: "owner", why: scope.reason };
  return { action: "merge", why: scope.bumps.map((b) => `${b.name} ${b.from} to ${b.to}`).join(", ") };
}

// The update-branch and auto-merge API calls need the user token, never the workflow token.
// Returning "skip" in a dry run too keeps its preview faithful to what this run can do.
export function dependabotAction(mergeStateStatus, canUpdateBranch) {
  if (!canUpdateBranch) return "skip";
  return dependabotNextStep(mergeStateStatus);
}

export function dependabotNextStep(mergeStateStatus) {
  return mergeStateStatus === "BEHIND" ? "update" : "merge";
}

// The reviewed SHA a head stands for, or null. The head itself when the reviewer approved it;
// otherwise only update-branch merge commits are tolerated: two parents, the second already in
// the base, the first leading (through more such merges) to an approved SHA. Anything else (a
// force-push, a plain commit, a merge bringing in commits the base lacks) is unreviewed.
// `verdictFor(sha)`, `parents(sha)` and `inBase(sha)` are injected, so this is tested without
// network.
export function approvedAncestor(headSha, { verdictFor, parents, inBase, maxDepth = 10 }) {
  let sha = headSha;
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (verdictFor(sha) === "approve") return sha;
    const ps = parents(sha) ?? [];
    if (ps.length !== 2 || !inBase(ps[1])) return null;
    sha = ps[0];
  }
  return null;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const updateBranch = args.includes("--update-branch");
const autoMerge = args.includes("--auto-merge");
const staleHoursArg = args.includes("--stale-hours") ? args[args.indexOf("--stale-hours") + 1] : "2";
const staleHours = Number(staleHoursArg);
if (!Number.isFinite(staleHours) || staleHours <= 0) {
  console.error(`--stale-hours needs a positive number of hours, got ${JSON.stringify(staleHoursArg)}`);
  process.exit(2);
}
const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
if (args.includes("--repo") && !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
  console.error(`--repo needs <owner>/<name>, got ${JSON.stringify(repo)}`);
  process.exit(2);
}
const now = Date.now();

function gh(ghArgs, { input } = {}) {
  // GH_REPO also fills the {owner}/{repo} placeholders of `gh api`.
  const env = repo ? { ...process.env, GH_REPO: repo } : process.env;
  return execFileSync("gh", ghArgs, { encoding: "utf8", input, env, maxBuffer: 64 * 1024 * 1024 });
}
let repositoryOwnerCache;
function repositoryOwner() {
  if (!repositoryOwnerCache) {
    const nameWithOwner = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
    repositoryOwnerCache = nameWithOwner.split("/")[0];
  }
  return repositoryOwnerCache;
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
    `Back to ${target} so the next tick picks it up (docs/self-hosting-development.md, "The PR gate").`,
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
    `${MARKER} New commits since the last review, head ${pr.headRefOid}: back to flow: needs-review for the next round (docs/self-hosting-development.md, "The PR gate").`,
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
    `Back to ${target} so the next developer tick picks it up (docs/self-hosting-development.md, "The PR gate").`,
  ]);
  return "expired";
}

// The login of the account the gate acts as (the token's): the reviewer agent posts with it, so
// only its comments carry a verdict the gate trusts. Undefined until read; null when unreadable
// (the workflow's GITHUB_TOKEN is not a user).
let gateLogin;
function ownLogin() {
  if (gateLogin === undefined) {
    try {
      gateLogin = gh(["api", "user", "--jq", ".login"]).trim() || null;
    } catch (error) {
      console.log(`own login unreadable (${error.message.split("\n")[0]}), no Dependabot auto-merge`);
      gateLogin = null;
    }
  }
  return gateLogin;
}

// A clean Dependabot PR behind its base gets the update-branch (the ruleset requires an
// up-to-date head). True when it was (or, in a dry run, would be) requested.
function keepCurrent(pr, mergeStateStatus) {
  if (mergeStateStatus !== "BEHIND") return false;
  console.log(`PR #${pr.number}: behind ${pr.baseRefName}, updating the branch`);
  if (!dryRun) gh(["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr.number}/update-branch`]);
  return true;
}

function commitParents(sha) {
  return JSON.parse(gh(["api", `repos/{owner}/{repo}/commits/${sha}`, "--jq", "[.parents[].sha]"]));
}

// Whether `sha` is already on `base` (the compare of base...sha says the SHA is behind or equal).
function inBase(base, sha) {
  const status = gh(["api", `repos/{owner}/{repo}/compare/${encodeURIComponent(base)}...${sha}`, "--jq", ".status"]);
  return ["behind", "identical"].includes(status.trim());
}

// A Dependabot PR already on auto-merge, re-verified every run: the ruleset does not dismiss
// stale approvals, so a push after the request (Dependabot force-pushing a major, a commit by
// anyone) would merge unreviewed. It stays queued only while it is labelled ready-to-merge, its
// head is an approved SHA or an update-branch merge of one, and its bumps are still patch or
// minor; otherwise auto-merge is disabled (fail closed, also when the checks cannot run) with
// one `[pr-gate]` comment per head. Returns the summary bucket.
function recheckAutoMerge(pr) {
  let why = null;
  const login = ownLogin();
  if (!pr.labels.some((label) => label.name === READY_LABEL)) {
    why = `no longer labelled ${READY_LABEL}`;
  } else if (!login) {
    why = "the gate's own login is unreadable, so the reviewer's approval cannot be re-checked";
  } else {
    const comments = issueComments(pr.number);
    const reviewed = approvedAncestor(pr.headRefOid, {
      verdictFor: (sha) => headVerdict(comments, { headSha: sha, login }),
      parents: commitParents,
      inBase: (sha) => inBase(pr.baseRefName, sha),
    });
    if (!reviewed) {
      why = "the head is neither a reviewer-approved commit nor an update-branch merge of one";
    } else {
      const decision = dependabotDecision(pr, { verdict: "approve", repositoryOwner: repositoryOwner() });
      if (decision.action !== "merge") why = decision.why;
    }
  }

  if (why) {
    console.log(`PR #${pr.number}: Dependabot on auto-merge, ${why}: disabling auto-merge`);
    if (dryRun) return "disabled";
    gh(["pr", "merge", String(pr.number), "--disable-auto"]);
    const said = issueComments(pr.number).some(
      (c) => c.body?.startsWith(`${MARKER} Auto-merge disabled`) && c.body.includes(`head ${pr.headRefOid}`),
    );
    if (!said) {
      comment(pr.number, [
        `${MARKER} Auto-merge disabled, head ${pr.headRefOid}: ${why}. A new review of this head is needed before it can merge (docs/self-hosting-development.md, "The PR gate").`,
      ]);
    }
    return "disabled";
  }

  // Still the reviewed change: only keep the branch current. A merge commit gets no new approval.
  const { mergeable, mergeStateStatus } = mergeState(pr);
  if (mergeable !== "MERGEABLE") return "skipped";
  return keepCurrent(pr, mergeStateStatus) ? "updated" : "queued";
}

// A Dependabot PR (see the header): approve, auto-merge and keep current, or leave it to the
// owner with one comment. Returns the summary bucket.
function dependabot(pr) {
  if (!autoMerge && !dryRun) return "skipped";
  if (!isDependabotCandidate(pr)) return "skipped";
  const owner = repositoryOwner();
  if (!isDependabotPr(pr, owner)) return "skipped";
  if (pr.autoMergeRequest) return recheckAutoMerge(pr);
  if (!pr.labels.some((label) => label.name === READY_LABEL)) return "skipped";

  const login = ownLogin();
  if (!login) return "skipped";
  const verdict = headVerdict(issueComments(pr.number), { headSha: pr.headRefOid, login });
  const decision = dependabotDecision(pr, { verdict, repositoryOwner: owner });
  if (decision.action === "skip") {
    console.log(`PR #${pr.number}: Dependabot, ${decision.why}, left alone`);
    return "skipped";
  }
  if (decision.action === "owner") {
    console.log(`PR #${pr.number}: Dependabot, stays for the owner: ${decision.why}`);
    if (dryRun || alreadyHanded(pr)) return "owner";
    comment(pr.number, [
      `${MARKER} Not merged automatically, head ${pr.headRefOid}: ${decision.why}. Only patch and minor bumps (a 0.x minor counts as major) merge on their own; this one stays for the owner (docs/self-hosting-development.md, "The PR gate").`,
    ]);
    return "owner";
  }

  const { mergeable, mergeStateStatus } = mergeState(pr);
  if (mergeable !== "MERGEABLE") {
    console.log(`PR #${pr.number}: Dependabot, merge state ${mergeable}, next run`);
    return "skipped";
  }
  const action = dependabotAction(mergeStateStatus, updateBranch);
  if (action === "skip") {
    console.log(
      `PR #${pr.number}: approved but ${mergeStateStatus === "BEHIND" ? "behind; branch update requires --update-branch" : "auto-merge needs the PR_GATE_TOKEN run (--update-branch)"}`,
    );
    return "skipped";
  }
  if (action === "update") {
    if (dryRun) {
      console.log(`PR #${pr.number}: would update ${pr.baseRefName}; auto-merge waits for review of the new head`);
      return "updated";
    }
    console.log(`PR #${pr.number}: behind ${pr.baseRefName}, updating the branch (the reviewer approves the new head)`);
    gh(["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr.number}/update-branch`]);
    return "updated";
  }
  console.log(`PR #${pr.number}: Dependabot ${decision.why}: approve ${pr.headRefOid.slice(0, 7)}, enable auto-merge`);
  if (dryRun) {
    keepCurrent(pr, mergeStateStatus);
    return "queued";
  }

  // Re-read the head right before approving: a push since the list (Dependabot rebasing, an
  // update-branch) is a commit the reviewer never saw.
  const fresh = JSON.parse(gh(["api", `repos/{owner}/{repo}/pulls/${pr.number}`]));
  if (fresh.head?.sha !== pr.headRefOid) {
    console.log(`PR #${pr.number}: head moved to ${String(fresh.head?.sha).slice(0, 7)}, not reviewed, left alone`);
    return "skipped";
  }
  const reviews = JSON.parse(gh(["api", "--paginate", `repos/{owner}/{repo}/pulls/${pr.number}/reviews`]));
  const approved = reviews.some(
    (r) => r.user?.login === login && r.state === "APPROVED" && r.commit_id === pr.headRefOid,
  );
  if (!approved) {
    gh([
      "api",
      "-X",
      "POST",
      `repos/{owner}/{repo}/pulls/${pr.number}/reviews`,
      "-f",
      "event=APPROVE",
      "-f",
      `commit_id=${pr.headRefOid}`,
      "-f",
      `body=${MARKER} Approved for the reviewer agent's approve on head ${pr.headRefOid} (Dependabot ${decision.why}).`,
    ]);
  }
  // --match-head-commit binds the request to the reviewed SHA: GitHub refuses it when the head
  // moved between the re-read above and this call.
  gh(["pr", "merge", String(pr.number), "--squash", "--auto", "--match-head-commit", pr.headRefOid]);
  keepCurrent(pr, mergeStateStatus);
  if (!alreadyHanded(pr)) {
    comment(pr.number, [
      `${MARKER} Auto-merge enabled, head ${pr.headRefOid}: merges when checks pass on an up-to-date head (squash, branch deleted). Dependabot ${decision.why}.`,
    ]);
  }
  return "queued";
}

// One PR; returns the summary bucket it falls in. Throws on a failed gh call.
function gate(pr) {
  const labels = pr.labels.map((label) => label.name);
  if (pr.isDraft) return "skipped";
  if (pr.headRefName.startsWith("dependabot/")) return dependabot(pr);
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
    `Handed ${pr.isCrossRepository ? "back to the contributor" : "to the developer"} with ${handoff} (docs/self-hosting-development.md, "The PR gate").`,
  ]);
  return "handed";
}

// A closed issue or a closed/merged PR loses its `flow:` labels. A label already gone (a
// DELETE answering 404, a human or a parallel run was faster) counts as removed. Returns the
// summary bucket.
function clearClosedFlow(item) {
  const labels = closedFlowLabels(item, { now });
  if (labels.length === 0) return null;
  const kind = item.pull_request ? "PR" : "issue";
  console.log(`${kind} #${item.number} (closed): removing ${labels.join(", ")}`);
  if (dryRun) return "cleared";
  for (const label of labels) {
    try {
      gh(["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/${item.number}/labels/${encodeURIComponent(label)}`]);
    } catch (error) {
      if (!/HTTP 404|Label does not exist/.test(String(error.stderr ?? error.message))) throw error;
    }
  }
  return "cleared";
}

function main() {
  const prs = JSON.parse(
    gh([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,isDraft,author,labels,baseRefName,headRefName,headRefOid,headRepositoryOwner,mergeable,mergeStateStatus,statusCheckRollup,body,isCrossRepository,autoMergeRequest",
    ]),
  );

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
    cleared: 0,
    queued: 0,
    owner: 0,
    disabled: 0,
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

  // Closed issues and closed/merged PRs (the REST issues list holds both). `since` filters on
  // the last update, never earlier than the close, so it only narrows the page count;
  // closedFlowLabels checks the close date itself.
  let closed = [];
  try {
    const since = new Date(now - CLEANUP_DAYS * 86_400_000).toISOString();
    closed = JSON.parse(
      gh(["api", "--paginate", `repos/{owner}/{repo}/issues?state=closed&per_page=100&since=${since}`]),
    );
  } catch (error) {
    console.error(`closed items: failed: ${(error.stderr || error.message).toString().trim()}`);
    summary.failed++;
  }
  for (const item of closed) {
    try {
      if (clearClosedFlow(item)) summary.cleared++;
    } catch (error) {
      console.error(`#${item.number}: failed: ${(error.stderr || error.message).toString().trim()}`);
      summary.failed++;
    }
  }

  console.log(
    `pr-gate${dryRun ? " (dry run)" : ""}: ${summary.handed} handed back, ${summary.updated} updated, ${summary.clean} clean, ${summary.locked} locked and alive, ${summary.expired} stale locks expired, ${summary.waiting} waiting for a contributor, ${summary.revived} back for review, ${summary.cleared} closed items cleared of flow labels, ${summary.queued} Dependabot PRs on auto-merge, ${summary.owner} Dependabot PRs left to the owner, ${summary.disabled} Dependabot auto-merges disabled,${summary.skipped} not gated, ${summary.failed} failed`,
  );
  if (summary.failed > 0) process.exitCode = 1;
}

// Run only as a script: the tests import closedFlowLabels without touching gh.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
