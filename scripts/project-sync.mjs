#!/usr/bin/env node
// Mirrors the label flow (docs/development.md "Issue and review flow by agents") into the
// GitHub Project "DuskFleet Flow": every open issue and PR of each synced repository is an
// item, and the item's Status is derived from its `flow:` label. Labels stay the source of
// truth: the agents move labels, this script moves the board. Without `--repo` it syncs the
// repository it runs in (gh resolves {owner}/{repo}); `--repo` can be repeated to sync several
// repositories of the organization into the one project (the website repository shares the
// board). Needs `gh auth refresh -s project` once.
//
//   node scripts/project-sync.mjs [--project <number>] [--repo <owner/name>]... [--dry-run]
//
// Status is set only when it differs; a closed or merged item is "Done" whatever its labels.
// Items already on the board are corrected whatever their repository; only the listed
// repositories get their missing open issues and PRs added.
// The Status options must exist with these exact names (the board was set up by hand once):
import { execFileSync } from "node:child_process";

const STATUS_BY_LABEL = {
  "flow: ready": "Ready",
  "flow: design-ready": "Design ready",
  "flow: in-progress": "In progress",
  "flow: needs-review": "Needs review",
  "flow: in-review": "In review",
  "flow: changes-requested": "Changes requested",
  "flow: contributor-changes": "Changes requested",
  "flow: ready-to-merge": "Ready to merge",
  "flow: needs-human": "Needs human",
};
const STATUS_NONE = "Backlog";
const STATUS_DONE = "Done";
// A design issue handed to review waits for the owner (reviewed in chat), not for the reviewer
// agent that works the "Needs review" column: it gets its own column.
const DESIGN_LABEL = "area: design";
const STATUS_DESIGN_REVIEW = { "flow: needs-review": "Design needs review" };

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectFlag = args.indexOf("--project");
const projectNumber = projectFlag === -1 ? 2 : Number(args[projectFlag + 1]);
const repos = args.flatMap((arg, i) => (arg === "--repo" && args[i + 1] ? [args[i + 1]] : []));

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function graphql(query, variables = {}) {
  const flags = Object.entries(variables).flatMap(([key, value]) => ["-F", `${key}=${value}`]);
  const out = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, ...flags]));
  if (out.errors) throw new Error(JSON.stringify(out.errors));
  return out.data;
}

if (repos.length === 0) repos.push(JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner);
for (const repo of repos) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`--repo expects owner/name, got "${repo}"`);
}
const owner = repos[0].split("/")[0];
// Log lines name the repository only when more than one is synced.
const label = (repo, number) => (repos.length > 1 ? `${repo}#${number}` : `#${number}`);

// Project, its Status field and the options by name.
const project = graphql(
  `query($owner: String!, $number: Int!) { organization(login: $owner) { projectV2(number: $number) {
    id title
    field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`,
  { owner, number: projectNumber },
).organization.projectV2;
if (!project) throw new Error(`project ${owner}/${projectNumber} not found (scope "project" granted to gh?)`);
const statusField = project.field;
const optionId = new Map(statusField.options.map((option) => [option.name, option.id]));
for (const name of [
  ...Object.values(STATUS_BY_LABEL),
  ...Object.values(STATUS_DESIGN_REVIEW),
  STATUS_NONE,
  STATUS_DONE,
]) {
  if (!optionId.has(name)) throw new Error(`Status option "${name}" missing in project "${project.title}"`);
}

// Every item of the project: content node id, state, labels and current Status.
const items = new Map(); // content node id -> { itemId, repo, number, kind, state, labels, status }
let cursor = null;
do {
  const page = graphql(
    `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 {
      items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
        id
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        content {
          __typename
          ... on Issue { id number state repository { nameWithOwner } labels(first: 20) { nodes { name } } }
          ... on PullRequest { id number state repository { nameWithOwner } labels(first: 20) { nodes { name } } } } } } } } }`,
    cursor ? { id: project.id, after: cursor } : { id: project.id },
  ).node.items;
  for (const node of page.nodes) {
    const content = node.content;
    if (!content?.id) continue; // draft issue or redacted
    items.set(content.id, {
      itemId: node.id,
      repo: content.repository.nameWithOwner,
      number: content.number,
      kind: content.__typename === "PullRequest" ? "PR" : "issue",
      state: content.state,
      labels: content.labels.nodes.map((label) => label.name),
      status: node.status?.name ?? null,
    });
  }
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (cursor);

// Open issues and PRs missing from the project are added (the project's auto-add workflow
// covers the issues of one repository only; a PR opened by an agent, or anything in another
// repository, would otherwise never reach the board).
const open = repos.flatMap((repo) => [
  ...JSON.parse(
    gh(["issue", "list", "-R", repo, "--state", "open", "--limit", "500", "--json", "id,number,labels"]),
  ).map((issue) => ({ ...issue, repo, kind: "issue" })),
  ...JSON.parse(gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "id,number,labels"])).map(
    (pr) => ({ ...pr, repo, kind: "PR" }),
  ),
]);
const summary = { added: 0, moved: 0, unchanged: 0 };
for (const content of open) {
  if (items.has(content.id)) continue;
  console.log(`add    ${content.kind} ${label(content.repo, content.number)}`);
  summary.added++;
  if (dryRun) continue;
  const itemId = graphql(
    `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
    { project: project.id, content: content.id },
  ).addProjectV2ItemById.item.id;
  items.set(content.id, {
    itemId,
    repo: content.repo,
    number: content.number,
    kind: content.kind,
    state: "OPEN",
    labels: content.labels.map((label) => label.name),
    status: null,
  });
}

function wantedStatus(item) {
  if (item.state !== "OPEN") return STATUS_DONE;
  const flow = item.labels.find((name) => name in STATUS_BY_LABEL);
  if (!flow) return STATUS_NONE;
  if (item.labels.includes(DESIGN_LABEL) && flow in STATUS_DESIGN_REVIEW) return STATUS_DESIGN_REVIEW[flow];
  return STATUS_BY_LABEL[flow];
}

for (const item of items.values()) {
  const wanted = wantedStatus(item);
  if (item.status === wanted) {
    summary.unchanged++;
    continue;
  }
  console.log(`status ${item.kind} ${label(item.repo, item.number)}: ${item.status ?? "(none)"} -> ${wanted}`);
  summary.moved++;
  if (dryRun) continue;
  graphql(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: {
      projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
    { project: project.id, item: item.itemId, field: statusField.id, option: optionId.get(wanted) },
  );
}

console.log(
  `${dryRun ? "[dry-run] " : ""}project "${project.title}": ${summary.added} added, ${summary.moved} moved, ${summary.unchanged} unchanged`,
);
