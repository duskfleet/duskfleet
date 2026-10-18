---
name: duskfleet-pr-fix
description: Protocol for answering review comments on a pull request of this repository - pick the PR with open threads, fix in a worktree on the PR branch, push, reply to every thread and resolve it. Load before working on review feedback here.
---

# Fixing review comments on a DuskFleet pull request

Review comments arrive as GitHub review threads (inline) plus one summary comment ending with
`VERDICT: changes`. Everything below runs from the main checkout; code is edited only in a git
worktree on the PR branch. The main checkout always stays on `main`.

## 1. Pick the PR

List open, non-draft PRs oldest first (`gh pr list --state open --json
number,headRefName,baseRefName,isDraft,createdAt`). For each one, fetch its review threads:

```
gh api graphql -f query='query{repository(owner:"duskfleet",name:"duskfleet"){pullRequest(number:<n>){reviewThreads(first:100){nodes{id isResolved path line comments(first:20){nodes{databaseId body}}}}}}}'
```

A thread is **open** when `isResolved` is false and the body of its last comment does not start
with `[df-pr-developer]` (that prefix marks an answer of this agent; a human reopened the point
only if a newer comment follows it). Take the first PR with at least one open thread. If none:
say "nothing to fix" and stop.

## 2. Worktree on the PR branch

```
bash scripts/pr-worktree.sh pr-<n> <headRefName> <baseRefName>
```

The script prints the worktree path on its last line (`.claude/worktrees/pr-<n>`). Every edit,
build, test and git command for the code happens inside that path (`git -C <wt> ...`,
`cd <wt> && <cmd>`). Never edit the main checkout.

## 3. Fix

Read the summary comment and every open thread. For each thread decide:

- **Fix it**: change the code in the worktree. Keep the fix minimal and in the spirit of the
  PR. A suggestion that calls for more work than a one-liner (a column, a migration, a test) is
  still implemented in full, not acknowledged.
- **Decline it**: only when the comment is factually wrong or contradicts CLAUDE.md.
  Explain why in the reply and leave the thread unresolved for a human.

Verify inside the worktree, one command each: `npm run build`, `npm run typecheck`,
`npm test` (and `npm run typecheck -w @duskfleet/web` when `apps/web` changed; a TS2882 on the
globals.css import is pre-existing). Fix what you broke. Keep the rules of this repo: no new
dependencies, migrations are new entries, status changes go through `assertTransition`, docs
updated when behaviour changed, nothing personal in a public repo.

## 4. Commit and push

Stage explicit paths (`git -C <wt> add <files>`; never `-A` or `.`; never `apps/web/node_modules`,
`next-env.d.ts` or `.next`). One commit: subject "Review fixes for #<n>: <what>", body listing
each thread addressed in one line. Push: `git -C <wt> push origin <headRefName>`. Never force-push,
never rebase, never push to `main`.

## 5. Reply and resolve

For every open thread, reply with the commit that fixes it (short SHA) or the reason it was
declined, prefixed with `[df-pr-developer]`:

```
gh api -X POST repos/duskfleet/duskfleet/pulls/<n>/comments/<databaseId of the first comment>/replies -f body='[df-pr-developer] Fixed in <sha>: <one line>'
```

Resolve the threads you fixed (thread `id` from the GraphQL query above):

```
gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<id>"}){thread{isResolved}}}'
```

Declined threads stay unresolved. Finally post one PR comment (`gh pr comment <n> --body ...`)
starting with `[df-pr-developer]` that lists what was fixed, what was declined and why, and the
verification results. The reviewer picks the PR up again on its next run because the new commit is
newer than its last verdict.

Finish with a one-line summary: PR number, commit, threads fixed / declined. Never merge or close
PRs, never delete branches, never edit the PR description.
