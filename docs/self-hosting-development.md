# How Duskfleet builds itself

Duskfleet's own issues and pull requests are worked by Duskfleet agents: a planner fills a
queue, two developers implement, a reviewer reviews, a designer and a promoter keep the Figma
file ahead of the dashboard. Humans write the issues, approve designs and merge. This page
describes that loop as it runs, and how to reproduce it on another repository. Sanitised copies
of every agent and schedule are under [`docs/examples/`](examples/): they are examples, never
loaded by the config.

## The roles

Every role is a Duskfleet user agent (in `data/agents/`, git-ignored) bound to the project.
Four of them are [links](agents.md#reusing-agents-a-project-already-defines) to a Claude Code
agent of the checkout (`.claude/agents/`, git-ignored too); the Duskfleet side adds only the
unattended envelope: permission mode, allow-list, budget and timeout. The procedures (how to
pick, lock, verify, hand off) live in four local skills (`.claude/skills/`, kept private) that
the agents load with the `Skill` tool. A Duskfleet run mounts the project's skills (verified
with Claude Code 2.1.302: `--permission-prompts none` with `--setting-sources project,local`
still mounts `.claude/skills` and the built-in skills), so an agent only needs `Skill` in its
`allowed_tools`.

| Agent | Kind | Model | Per run |
|---|---|---|---|
| [`df-planner`](examples/agents/df-planner.md) | link to [`df-planner`](examples/claude-agents/df-planner.md) | sonnet | Snapshots the flow with `node scripts/issue-plan.mjs`, declares blockers, parks vague issues with `flow: needs-human`, fills `flow: ready` up to six within the caps. Read-only on files. |
| [`df-designer`](examples/agents/df-designer.md) | link to [`df-designer`](examples/claude-agents/df-designer.md) | opus | One `area: design` issue labelled `flow: design-ready`: Figma work on a WIP page, contrast checked in both modes, hand-off comment, `flow: needs-review`. Never touches code. |
| [`df-design-promoter`](examples/agents/df-design-promoter.md) | own | opus | One `flow: approved` design issue: moves the WIP nodes to the main Figma page, archives the WIP page, opens the `area: web` implementation issue with `flow: ready`, closes the design issue. |
| [`df-back-end-developer`](examples/agents/df-back-end-developer.md) | link to [`df-pr-developer`](examples/claude-agents/df-pr-developer.md) | opus | One unit of work: a `flow: changes-requested` PR first, else the top `flow: ready` issue; worktree, verify, push, PR with `flow: needs-review`. Skips `area: web` issues and `ui/*` PRs. |
| [`df-ui-developer`](examples/agents/df-ui-developer.md) | own | opus | The same for the dashboard: only `area: web` issues and `ui/*` PRs, with the Figma MCP to read the frames it implements. |
| [`df-pr-reviewer`](examples/agents/df-pr-reviewer.md) | link to [`df-pr-reviewer`](examples/claude-agents/df-pr-reviewer.md) | sonnet | One `flow: needs-review` PR: a correctness pass by a subagent, then the repository rules and the issue's acceptance criteria; one comment ending with `VERDICT: approve` or `VERDICT: changes`, then `flow: ready-to-merge` or `flow: changes-requested`. Read-only. |

## The label state machine

The state machine is a set of `flow:` labels on GitHub; there is no coordinator process.
Issues carry the development state, PRs carry the review state, and each agent finds its own
work from a label query when its schedule wakes it:

```
issue:  priority: * ──(planner, when unblocked)──► flow: ready ──(developer picks, swaps the label first)──► flow: in-progress ──► closed by the merge
PR:     flow: needs-review ──► flow: in-review ──► flow: changes-requested ──► flow: needs-review … ──► flow: ready-to-merge
fork PR:                        flow: in-review ──► flow: contributor-changes ──(contributor pushes; PR gate)──► flow: needs-review …
design: flow: design-ready ──(designer)──► flow: in-progress ──► flow: needs-review ──(owner, in chat)──► flow: approved ──(promoter)──► closed + area: web issue in flow: ready
                                                                       └──(owner)──► flow: changes-requested ──(designer) …
```

- A human writes issues and sets their `priority:` labels; a priority is the consent for an
  issue to be developed. The planner fills the `flow: ready` queue from them (below), and a
  human can still label an issue `flow: ready` by hand. The developers take `priority: high`
  first, then oldest. `flow: needs-human` parks anything the loop cannot decide;
  `flow: ready-to-merge` means a human merges — agents never do.
- The planner is read-only on files. `node scripts/issue-plan.mjs` prints a JSON
  snapshot of the flow (labels, declared blockers and whether they are still open, the open PRs
  closing each issue, a ranked candidate list); the agent then declares missing dependencies,
  parks issues that need a decision with `flow: needs-human`, and promotes candidates to
  `flow: ready` up to six, at most two units of work in flight per area, and none while eight
  PRs wait for a merge. It never promotes an issue without a `priority:` label, a `roadmap`
  issue, one that already has an open PR, or an `area: website` issue: the public site
  (`duskfleet-website`) is the owner's work, and the developer agents of this repository
  would build it into the dashboard.
- The planner also adopts contributor pull requests: a PR from a fork, not a draft, with no
  `flow:` label yet (the snapshot lists them under `adoptions`) is handed to the reviewer with
  `flow: needs-review`, and every open issue it closes is locked with `flow: in-progress` (its
  previous `flow:` label removed), so the developer never starts work a contributor already
  did. A PR from a branch of this repository is an agent's own and labels itself. No agent
  can push to a fork, so a contributor's PR is never handed to the developer: the reviewer
  (and the PR gate) hands it back with `flow: contributor-changes`, a label the developer
  does not pick; when the contributor pushes, the PR gate moves it back to
  `flow: needs-review` for the next round.
- Dependencies are lines in an issue's body or comments: `Blocked by #65` (or
  `Depends on #62, #61`). While one of them is open the issue carries the `blocked` label and
  stays out of the queue; the planner removes the label once all of them are closed. A
  `blocked` label without such a line is a human's and is left alone. To drop a dependency,
  delete the line (the planner's are comments starting with `[df-planner]`).
- The developers do one unit of work per run, rework before new work: a PR labelled
  `flow: changes-requested` (or, as a fallback, an unlabelled PR with unresolved review
  threads) is fixed in a worktree on the PR branch (`scripts/pr-worktree.sh <name> <branch>
  <base>`), one commit pushed, every thread answered with a fixed prefix and resolved;
  otherwise the top `flow: ready` issue is implemented on a new branch (`issue/<n>-<slug>`
  for the back end, `ui/<n>-<slug>` for the dashboard) and opened as a PR whose body says
  `Closes #<n>`. Either way the PR is handed to the reviewer with `flow: needs-review`. Each
  pickup swaps the label first, as a lock against a second run. The split is by label and
  branch prefix: `df-ui-developer` takes `area: web` issues and `ui/*` PRs (it has the Figma
  MCP), `df-back-end-developer` everything else.
- The reviewer picks the oldest PR labelled `flow: needs-review` (fallback: the oldest open PR
  without a `VERDICT:` comment naming its current head SHA), swaps it to `flow: in-review`,
  runs a correctness pass through a subagent with a fixed brief (it posts the findings that
  hold as inline comments), then checks the rules of CLAUDE.md — and, for a PR that closes an
  issue, the issue's own acceptance criteria — and posts one summary comment ending with
  `VERDICT: approve` or `VERDICT: changes`. The verdict's label (`flow: ready-to-merge` or
  `flow: changes-requested`; `flow: contributor-changes` when the PR comes from a fork) is the
  hand-off. Read-only agent; after three `VERDICT: changes`
  rounds it parks the PR with `flow: needs-human`. The built-in `code-review` skill is not
  used unattended: its fork gathers context with commands no allow-list can permit
  (`git diff @{upstream}...HEAD`, `;` chains), so it was denied in most runs.
- Dependabot PRs take a short path instead of the two passes: all checks green, only manifests,
  lockfile or workflow files changed, no added dependency, no major bump (and `@types/node`
  on the Node floor's major) → `flow: ready-to-merge`; a red check or a bump outside those
  bounds → `flow: changes-requested`, and a wanted major → `flow: needs-human`. Still a
  review: grouped bumps have broken the web build before.
- Design issues (`area: design`) have their own ready label, `flow: design-ready`, so the
  developers never pick them. The designer works on a `WIP/DS-NN <slug>` page and never on the
  main frames; the owner reviews the WIP page in chat and labels the issue `flow: approved`
  (or `flow: changes-requested`). The promoter then moves the approved nodes to the main page
  (moving keeps node ids, so instances stay linked), opens the `area: web` implementation issue
  in `flow: ready` for `df-ui-developer`, and closes the design issue.

## The PR gate

The PR gate keeps the labels true to the merge state, with no agent involved. A PR labelled
`flow: needs-review` or `flow: ready-to-merge` was fine when it got the label; once `main`
moves it can conflict, and the ruleset on `main` requires an up-to-date branch with a green
`checks` job. `node scripts/pr-gate.mjs [--dry-run] [--update-branch]` reads every open PR
in those two states (drafts and Dependabot excluded) and, when it conflicts with its base or
a required check (read from the rulesets on the base branch; a failed non-required job such
as `sync` does not count) failed on its head, swaps the label to `flow: changes-requested`
(`flow: contributor-changes` for a PR from a fork) and then posts one comment starting with
`[pr-gate]` (head SHA and the reasons; it is written last, so a failed label call is retried
on the next run). One failing PR does not stop the others; the script exits non-zero at the
end. The developer's next run merges the base into the branch or fixes the check, and hands
the PR back to the reviewer as after any review. A PR that is merely behind its base is
updated in place with `--update-branch`. Idempotent: a head that already carries a
`[pr-gate]` comment is left alone, so a human can overrule the gate by relabelling. A PR
labelled `flow: contributor-changes` with a commit on its head newer than the label goes back
to `flow: needs-review` with a `[pr-gate]` comment: the contributor answered, the reviewer
looks again. The workflow `.github/workflows/pr-gate.yml` runs it on every push to `main`,
after every CI run, once an hour and on demand. With the repository secret `PR_GATE_TOKEN` (a
user token with write access; scopes in the workflow header) it also updates branches and its
label changes fire the project sync; with the default token it only relabels, since a push or
a label set by `GITHUB_TOKEN` starts no other workflow. The reviewer checks the same state
before and after its passes (`gh pr view <n> --json mergeable,statusCheckRollup`): a
conflicting or red PR gets `VERDICT: changes` without a review.

The gate also expires stale locks. `flow: in-progress` and `flow: in-review` are swapped in
first as a lock against a second run; a run that dies after that (timeout, killed child, an
ending such as "tests are running, I'll pick up when they finish") leaves the lock behind,
every later run skips the item as someone else's and nothing in the flow looks at it again
(PR #164 sat `in-progress` for 17 hours with no push). No run outlives its timeout, so a lock
older than `--stale-hours` (default 2, above the longest agent timeout) with no activity since
it was set is an orphan and goes back to the state it was taken from: a PR `in-progress` with
no commit on its head since the label to `flow: changes-requested`; a PR `in-review` with no
`VERDICT:` for its head since the label to `flow: needs-review` (a verdict posted but never
labelled gets its label instead, no second review, but only once the lock is that old too, so
a live reviewer between its comment and its label swap is never raced; the verdict counts
only at the start of a line); an issue `in-progress` with no open PR closing it to
`flow: ready`. Each gets a `[pr-gate]` comment naming the lock and its age. A pickup is a new
label event, so the clock restarts and a run still at work is never interrupted. Agents keep
their side of it: swap the label first, push or post before the timeout, never end a run with
work "still running in the background".

## Schedules and limits

One cron schedule per agent ([`docs/examples/schedules.yaml`](examples/schedules.yaml)),
all in `Europe/London`, staggered so a PR opened by a developer meets the reviewer within the
half hour and a planner pass lands just before a developer tick:

| Schedule | Cron | Agent |
|---|---|---|
| UI developer | `0,30 * * * *` | `df-ui-developer` |
| PR review | `10,40 * * * *` | `df-pr-reviewer` |
| Issue planner | `17,47 7-21 * * *` | `df-planner` |
| Back-end developer | `20,50 * * * *` | `df-back-end-developer` |
| Designer | `25,55 8-20 * * 1-5` | `df-designer` |

`df-design-promoter` has no schedule: the owner starts it with `run_agent` after approving a
design. The limits are the per-run ones in each agent file (`max_budget_usd` 3 to 10,
`timeout_minutes` 20 to 60), `max_concurrent_per_agent: 1`, and the scheduler's
`auto_pause_after: 5` (five empty or needs-review runs in a row pause the schedule; see
[auto-pause](schedules.md#auto-pause)). No [daily cap](agents.md#daily-caps) or
[monthly budget](agents.md#monthly-budgets) is set: an idle tick costs one short run, since
every prompt ends with "if there is nothing to do, report that and stop". The planner, the
designer and the promoter are `isolated: true` (they never edit the checkout), so they do not
count against the one-run-per-project guard; the developers work in worktrees and the
project limit (`max_concurrent_per_project: 4`) lets both run at once.

## What humans do

- Write issues with a scope and acceptance criteria, and set `priority:` and `area:` labels.
  Without a priority the planner never promotes an issue.
- Answer `flow: needs-human` items: decide, then relabel (`flow: ready`, `flow: changes-requested`)
  or close.
- Review designs (the WIP page) and label them `flow: approved` or `flow: changes-requested`,
  then start `df-design-promoter`.
- Merge `flow: ready-to-merge` PRs after a last look (the reviewer leaves visual checks of
  the dashboard to the human). Agents never merge, close PRs or delete branches.

## The project board

The GitHub Project "DuskFleet Flow" (org project 2) is a read-only mirror of the labels:
`node scripts/project-sync.mjs [--repo <owner/name>]... [--dry-run]` adds every open issue and
PR of the given repositories (the current one by default) to the project (the project's
auto-add workflow covers the issues of this repository only) and sets each item's Status from
its `flow:` label (`Backlog` without one, `Done` when closed or merged; an `area: design` issue
in `flow: needs-review` is `Design needs review`, since the owner reviews designs in chat while
the reviewer agent works the `Needs review` column). The website repository
shares the board, so the workflow passes both. Labels stay the source of truth:
agents never touch the project, and a Status dragged on the board is overwritten on the next
sync. Its views: *Board* (open items by Status, Backlog hidden), *Backlog* (open issues with no
`flow:` label, to pick what to promote), *Needs me* (`Ready to merge` and `Needs human`, the two
states that wait for a human), *All*. Run by hand, the script needs the `project` scope once
(`gh auth refresh -h github.com -s project`). The workflow `.github/workflows/project-sync.yml`
runs it on every open / close / label change of an issue or PR, once an hour as a safety net
and on demand (*Actions → Project sync → Run workflow*); it needs the repository secret
`PROJECT_SYNC_TOKEN` (the default token cannot touch an organization project; the scopes are
listed in the workflow header). Without the secret the job fails loudly and the board simply
lags until the script is run by hand. The website repository carries a copy of the workflow
that checks out this repository for the script, so its own label changes reach the board at
once instead of on the next hourly run; it needs the same secret there.

## Known limits

- **No coordinator.** Each agent reads the labels when its schedule fires; nothing hands work
  over directly. A hand-off waits for the next tick of the receiving agent (up to 30 minutes).
- **Busy means skip.** A tick whose agent is still running is recorded as `skipped_busy` and
  lost, never queued. A long developer run simply delays the next unit of work.
- **Locks are labels.** Two runs could race between a label query and the label swap; the
  schedules are staggered and `max_concurrent_per_agent: 1` keeps one run per agent, and the
  PR gate expires the locks a dead run leaves behind.
- **The board lags** when the project sync secret is missing; labels are the truth.
- **Shell shapes.** Unattended runs get no permission prompts, so every command an agent
  needs must match its allow-list exactly: one plain command per call, multi-line bodies
  through `--body-file`, colon scripts (`npm run lint:fix`) listed one by one. The agent
  prompts in the examples carry these rules; most lost runs came from a denied command.
- **Headless runs end with the turn.** Anything left running in the background is killed, so
  the prompts forbid background tasks and require a push before the final message.

## Reproduce it on another repository

1. **Labels.** Create the `flow:` set: `flow: ready`, `flow: in-progress`,
   `flow: needs-review`, `flow: in-review`, `flow: changes-requested`, `flow: ready-to-merge`,
   `flow: needs-human`, plus `flow: contributor-changes` if you accept fork PRs and
   `flow: design-ready`, `flow: approved` if you run the design loop. Add `blocked`,
   `priority: high`, `priority: medium`, `priority: low` and the `area:` labels your routing
   uses (`area: web`, `area: design` here). Labels move through
   `gh api -X POST repos/<owner>/<repo>/issues/<n>/labels -f "labels[]=<label>"` and
   `gh api -X DELETE "repos/<owner>/<repo>/issues/<n>/labels/<url-encoded label>"`.
2. **Project agents and skills.** Put the Claude Code agents
   ([`docs/examples/claude-agents/`](examples/claude-agents/)) in the repository's
   `.claude/agents/`, and write the skills they name (`<repo>/.claude/skills/<name>/SKILL.md`):
   one each for implementing an issue, fixing a PR, reviewing a PR and planning the queue.
   The skills hold your repository's verification commands, branch naming and review rules;
   this page describes what each does.
3. **Register the project and the agents.** Add the checkout to the registry
   (`data/projects.yaml`, or let `create_agent` register the folder), then create one
   Duskfleet agent per role with `create_agent` (`kind: link` with `claude_agent` and
   `project`, or `kind: own` with a `system_prompt`) or by copying an example from
   [`docs/examples/agents/`](examples/agents/) into `data/agents/` and replacing
   `<project-id>`, `<owner>/<repo>` and `<figma-file-key>`. Adapt the `allowed_tools`
   to your build commands: an agent is denied anything not listed.
4. **Try each agent once by hand** with `run_agent` (or `npm run cli -- run`) on a single
   issue, and read the run (`get_run`, the dashboard) for permission denials before
   scheduling it.
5. **Schedules.** Create one schedule per agent with `create_schedule`, using the entries of
   [`docs/examples/schedules.yaml`](examples/schedules.yaml) as arguments, then keep a
   scheduler running (`npm run cli -- install-service`; see [Schedules](schedules.md)).
6. **Optional:** copy `scripts/issue-plan.mjs`, `scripts/pr-gate.mjs` with
   `.github/workflows/pr-gate.yml`, and `scripts/project-sync.mjs` with its workflow; a ruleset
   on the default branch that requires CI makes the gate meaningful.
7. **Human steps** from then on: write issues with priorities, answer `flow: needs-human`,
   approve designs, merge `flow: ready-to-merge`.
