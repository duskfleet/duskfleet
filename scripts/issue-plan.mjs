#!/usr/bin/env node
// Prints a JSON snapshot of the issue flow for the planner agent (and for humans):
// open issues with their flow / priority / area labels, their declared blockers and whether
// those are still open, the open PRs that close them, and two deterministic lists:
//   labelActions - `blocked` labels to add or remove, from declared blockers only;
//   candidates   - issues that may be promoted to `flow: ready`, best first.
// Read-only: it never changes a label. Run from the repository (gh resolves {owner}/{repo}).
//
//   node scripts/issue-plan.mjs
//
// A blocker is declared by a line in the issue body or in one of its comments, optionally after
// a bracketed tag such as the planner's own:
//   Blocked by #65            Depends on #62, #61            [df-planner] Blocked by #65: why
// It is open while that issue (or PR) is open. A `blocked` label with no declared blocker was
// set by a human and is left alone.
import { execFileSync } from "node:child_process";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const BLOCKER_LINE = /^[\s>*-]*(?:\[[\w-]+\]\s*)?(?:blocked by|depends on)\b[:\s]*((?:#\d+[\s,;]*(?:and\s+)?)+)/gim;
const CLOSES = /\b(?:closes|fixes|resolves)\s+#(\d+)/gi;

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function blockersOf(texts) {
  const found = new Set();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(BLOCKER_LINE)) {
      for (const ref of match[1].matchAll(/#(\d+)/g)) found.add(Number(ref[1]));
    }
  }
  return [...found].sort((a, b) => a - b);
}

function labelValue(labels, prefix) {
  const label = labels.find((name) => name.startsWith(prefix));
  return label ? label.slice(prefix.length) : null;
}

const openIssues = JSON.parse(
  gh(["issue", "list", "--state", "open", "--limit", "500", "--json", "number,title,labels,body,createdAt,comments"]),
);
const openPrs = JSON.parse(
  gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,headRefName,labels,body,files,isDraft",
  ]),
);
// State of every issue and PR, so a blocker that is a closed issue or a merged PR counts as done.
const states = new Map(
  gh([
    "api",
    "--paginate",
    "repos/{owner}/{repo}/issues?state=all&per_page=100",
    "--jq",
    '.[] | "\\(.number) \\(.state)"',
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [number, state] = line.split(" ");
      return [Number(number), state];
    }),
);

const prs = openPrs.map((pr) => {
  const labels = pr.labels.map((label) => label.name);
  const closes = new Set([...(pr.body ?? "").matchAll(CLOSES)].map((match) => Number(match[1])));
  const branchIssue = /^issue\/(\d+)-/.exec(pr.headRefName);
  if (branchIssue) closes.add(Number(branchIssue[1]));
  return {
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    draft: pr.isDraft,
    flow: labelValue(labels, "flow: "),
    closes: [...closes].sort((a, b) => a - b),
    dirs: [...new Set(pr.files.map((file) => file.path.split("/").slice(0, 2).join("/")))].sort(),
  };
});

const issues = openIssues.map((issue) => {
  const labels = issue.labels.map((label) => label.name);
  const blockers = blockersOf([issue.body, ...issue.comments.map((comment) => comment.body)]).filter(
    (number) => number !== issue.number,
  );
  return {
    number: issue.number,
    title: issue.title,
    createdAt: issue.createdAt,
    priority: labelValue(labels, "priority: "),
    areas: labels.filter((name) => name.startsWith("area: ")).map((name) => name.slice(6)),
    flow: labelValue(labels, "flow: "),
    blockedLabel: labels.includes("blocked"),
    roadmap: labels.includes("roadmap"),
    blockers,
    openBlockers: blockers.filter((number) => states.get(number) !== "closed"),
    openPrs: prs.filter((pr) => pr.closes.includes(issue.number)).map((pr) => pr.number),
  };
});

const labelActions = [];
for (const issue of issues) {
  if (issue.openBlockers.length > 0 && !issue.blockedLabel) {
    labelActions.push({ issue: issue.number, add: "blocked", because: issue.openBlockers });
  }
  if (issue.blockedLabel && issue.blockers.length > 0 && issue.openBlockers.length === 0) {
    labelActions.push({ issue: issue.number, remove: "blocked", because: issue.blockers });
  }
}

const candidates = issues
  .filter(
    (issue) =>
      issue.priority !== null &&
      issue.flow === null &&
      !issue.roadmap &&
      issue.openBlockers.length === 0 &&
      (!issue.blockedLabel || issue.blockers.length > 0) &&
      issue.openPrs.length === 0,
  )
  .sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3) || a.createdAt.localeCompare(b.createdAt),
  )
  .map((issue) => issue.number);

const count = (list, flow) => list.filter((item) => item.flow === flow).length;

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      counts: {
        openIssues: issues.length,
        ready: count(issues, "ready"),
        inProgress: count(issues, "in-progress"),
        needsHuman: count(issues, "needs-human") + count(prs, "needs-human"),
        untriaged: issues.filter((issue) => issue.priority === null && issue.openPrs.length === 0).length,
        openPrs: prs.length,
        prsAwaitingMerge: count(prs, "ready-to-merge"),
      },
      labelActions,
      candidates,
      issues,
      prs,
    },
    null,
    2,
  ),
);
