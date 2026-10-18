---
name: duskfleet-pr-review
description: Review protocol for pull requests of this repository - how to pick the PR, the repo-specific rules to check after /code-review, how to post the verdict. Load before reviewing any PR here.
---

# Reviewing a DuskFleet pull request

Two passes per PR. The built-in `code-review` skill hunts correctness bugs; this skill adds the
rules of this repository, which a generic review does not know, and fixes the posting protocol
so that the developer agent and the next review round can find their way.

## 1. Pick the PR

List candidates:

```
gh pr list --state open --json number,title,headRefName,baseRefName,createdAt,isDraft
```

Skip drafts. For each remaining PR, oldest first, read `gh pr view <n> --json comments,commits`.
Take the first PR with **no comment containing `VERDICT:` that is newer than its last commit**.
A PR that already has three or more `VERDICT: changes` comments is stuck: post one comment
"VERDICT: changes - three review rounds without convergence, a human has to decide" only if the
latest commit is newer than the last verdict, and move to the next PR. If no PR qualifies, say
"nothing to review" and stop.

## 2. Pass one: correctness, with the built-in skill

Invoke the Skill tool with `skill: code-review` and `args: <n> high --comment`. It reviews the
PR for bugs and posts its findings as inline review comments on GitHub. Let it finish; do not
repeat its findings in pass two.

## 3. Pass two: the rules of this repository

Read the diff (`gh pr diff <n>`), CLAUDE.md, and the touched files. Check every rule below.
Each violation becomes one inline comment on the offending line:

```
gh api -X POST repos/duskfleet/duskfleet/pulls/<n>/comments -f body='...' -f commit_id=<head sha> -f path=<file> -F line=<line> -f side=RIGHT
```

(`<head sha>` is the last entry of `gh pr view <n> --json commits`.) Say what to change, not
only what is wrong.

Rules:

- **Schema**: a change is a NEW entry in the migrations list of `packages/core/src/storage/db.ts`,
  never an edit of an existing one.
- **Run status**: only `RunManager` changes a run's status, always through `assertTransition`.
- **Tests**: new behaviour is covered by `packages/mcp/test/*.test.js` without launching a real
  Claude (`fake-claude.js` replays stream-json; a new event shape gets a case there).
- **Docs in sync**: PLAN.md, README.md, docs/*.md (and CLAUDE.md when rules change) reflect a
  behaviour change. A new `claude` CLI flag is listed as verified in PLAN.md section 1.
- **Dependencies**: no new runtime dependency beyond `@modelcontextprotocol/sdk`, `zod`, `yaml`;
  no native addons; no new framework.
- **Public repo**: no usernames, home paths, machine-specific values, or references to `notes/`
  in code, docs, examples or the PR text.
- **Layering**: `packages/core` imports nothing from MCP or React; the dashboard never mutates
  runs or builtin agents (its only writes are the server actions on user agent files and
  schedule rows).
- **Agent files**: code never writes into `config/agents`; agent file I/O lives in
  `core/src/config/agent-files.ts`.
- **Scheduler**: busy means `skipped_busy`, never a queue; no catch-up of missed ticks; the
  `serve` lease role preempts the others; units for `install-service` are rendered, never
  versioned.
- **Dashboard**: no component library; colours and spacing come from the tokens in
  `apps/web/app/globals.css`; a completed run with a permission denial is "needs review"
  (amber), never plain green.
- **Scope**: nothing unrelated changed; a stacked PR has the right base branch.

Do not comment on style, naming or formatting.

## 4. Verdict

Post exactly one PR comment (`gh pr comment <n> --body ...`) that summarises both passes:
findings most important first, at most 8 lines, each naming the file. The last line is
`VERDICT: approve` or `VERDICT: changes`. Approve when only cosmetic nits remain; never approve
a PR that breaks a rule above or has an open correctness finding.

Finish with a one-line summary: PR number and verdict. Never merge, close or edit PRs, never
resolve review threads: that is the developer's job.
