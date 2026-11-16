# Run a development loop with agents

A repository can be developed by scheduled agents: one implements issues and opens pull
requests, one reviews them, humans write the issues and merge. This guide shows how to set
that up with Duskfleet on any GitHub repository. It is the shape Duskfleet itself is developed
with; the exact agents, prompts and schedules are an installation's own and are not part of
this repository.

Real runs cost money. Try each agent once by hand with `--model haiku` before scheduling it.

## The idea: labels as the state machine

There is no coordinator process. Every piece of work carries a `flow:` label on GitHub, each
agent finds its own work from a label query when its schedule wakes it, and the label it
leaves behind is the hand-off to the next role. Issues carry the development state, PRs carry
the review state:

```
issue:  (human: priority set) ──► flow: ready ──(developer picks, swaps the label first)──► flow: in-progress ──► closed by the merge
PR:     flow: needs-review ──(reviewer)──► flow: in-review ──► flow: changes-requested ──(developer)──► flow: needs-review … ──► flow: ready-to-merge ──(human merges)
```

Two labels stop the loop on purpose: `flow: needs-human` parks anything an agent cannot
decide, and `flow: ready-to-merge` means a human merges. Agents never merge, close PRs or
delete branches.

The roles, each one Duskfleet agent with its own schedule:

| Role | Per run | Files |
|---|---|---|
| Developer | One unit of work, rework before new work: a PR labelled `flow: changes-requested` is fixed on its branch (every review thread answered and resolved), else the top `flow: ready` issue is implemented on a new branch and opened as a PR whose body says `Closes #<n>`. Either way the PR is handed on with `flow: needs-review`. | Writes, in a worktree |
| Reviewer | The oldest PR labelled `flow: needs-review`: a correctness pass, then the repository's rules and the issue's acceptance criteria; one summary comment ending with a verdict line, then `flow: ready-to-merge` or `flow: changes-requested`. | Read-only |
| Planner (optional) | Keeps the `flow: ready` queue filled from the prioritised issues, declares blockers (`Blocked by #<n>` lines in an issue body), parks vague issues with `flow: needs-human`. | Read-only |

Each pickup **swaps the label first** (`flow: ready` to `flow: in-progress`, `flow: needs-review`
to `flow: in-review`) as a lock against a second run of the same role.

## Set it up

1. **Labels.** Create `flow: ready`, `flow: in-progress`, `flow: needs-review`,
   `flow: in-review`, `flow: changes-requested`, `flow: ready-to-merge`, `flow: needs-human`,
   and the `priority:` and `area:` labels your routing uses. Unattended agents move labels with
   plain `gh api` calls, one per command, so the allow-list can name them:

   ```bash
   gh api -X POST repos/<owner>/<repo>/issues/<n>/labels -f "labels[]=flow: in-progress"
   gh api -X DELETE "repos/<owner>/<repo>/issues/<n>/labels/flow%3A%20ready"
   ```

2. **The procedures live in the repository, not in the prompt.** Put how to pick, lock,
   verify, push and hand off in a skill (`.claude/skills/<name>/SKILL.md`) or in a project
   agent (`.claude/agents/<name>.md`) of the target repository, with the verification
   commands, branch naming and review rules of that codebase. A Duskfleet run mounts the
   project's skills, so an agent only needs `Skill` in its `allowed_tools`. The Duskfleet
   agent then adds only the unattended envelope: permission mode, allow-list, model, budget,
   timeout. If the project already defines the agent, [link](../agents.md#reusing-agents-a-project-already-defines)
   to it instead of writing a second persona.

3. **One Duskfleet agent per role.** An `own` developer, as a file in `data/agents/` (or the
   same fields through `create_agent`):

   ```markdown
   ---
   id: my-developer
   name: Developer
   project: <project-id>
   model: opus
   permission_mode: dontAsk
   allowed_tools:
     - Read
     - Grep
     - Glob
     - Edit
     - Write
     - Skill
     - Bash(git status:*)
     - Bash(git checkout:*)
     - Bash(git add:*)
     - Bash(git commit:*)
     - Bash(git push:*)
     - Bash(git worktree:*)
     - Bash(npm test:*)
     - Bash(npm run build:*)
     - Bash(gh pr list:*)
     - Bash(gh pr view:*)
     - Bash(gh pr create:*)
     - Bash(gh issue list:*)
     - Bash(gh issue view:*)
     - Bash(gh api:*)
   max_budget_usd: 5
   timeout_minutes: 45
   ---

   You run unattended; nobody can answer questions. Do one unit of work and stop.
   First a PR labelled "flow: changes-requested": fix it on its branch, push one commit,
   answer and resolve every review thread. Else the top "flow: ready" issue: swap its
   label to "flow: in-progress" before anything else, implement it in a worktree on a
   branch named issue/<n>-<slug>, run the verification commands, push, open a PR whose
   body says "Closes #<n>". Hand the PR on with "flow: needs-review". Never merge.
   Never leave work running in the background: push before your final message. If there
   is nothing to do, say "nothing to do" and stop.
   ```

   The reviewer is the same with `Edit`, `Write` and `NotebookEdit` in `disallowed_tools`,
   `isolated: true` (it never edits the checkout, so it does not count against the
   one-run-per-project guard), and a prompt that ends every review with a fixed verdict line
   the gate below can read. Everything an agent runs must match its allow-list exactly: one
   plain command per call, multi-line bodies through `--body-file`, colon scripts
   (`npm run lint:fix`) listed one by one. Most lost runs come from a denied command, so read
   the first runs for denials before scheduling.

4. **Schedules.** One cron schedule per agent, staggered so a PR opened by the developer
   meets the reviewer soon after, for example the developer at `:00` and `:30` and the
   reviewer at `:10` and `:40`:

   ```
   create_schedule { name: "Developer", agent_id: "my-developer", cron: "0,30 * * * *",
                     time_zone: "<tz>", prompt: "Work one unit of the label flow. If there is nothing to do, report that and stop." }
   ```

   An idle tick costs one short run, since the prompt ends with "nothing to do"; the
   scheduler's [auto-pause](../schedules.md#auto-pause) stops a schedule whose runs keep ending
   empty or needs review. Keep a scheduler running (`npm run cli -- install-service`, see
   [Schedules](../schedules.md)).

5. **Keep the labels true.** `main` moves, PRs go stale, a run can die after taking its lock.
   `scripts/pr-gate.mjs` in this repository (run by `.github/workflows/pr-gate.yml`) does the
   bookkeeping with no agent involved: a PR waiting for review or merge that conflicts with
   its base or whose required check failed goes back to `flow: changes-requested` with one
   comment per head; a lock older than `--stale-hours` with no activity since it was set goes
   back to the state it was taken from; closed issues and merged PRs lose their `flow:` labels.
   `scripts/issue-plan.mjs` prints the planner's snapshot of the flow and
   `scripts/project-sync.mjs` mirrors the labels into a GitHub Project board. Copy what you
   need; each script's header documents its flags and the token it expects.

## What humans do

- Write issues with a scope and acceptance criteria, and set a `priority:` label: a
  priority is the consent for an issue to be developed.
- Answer `flow: needs-human` items: decide, then relabel or close.
- Merge `flow: ready-to-merge` PRs after a last look.

## Known limits

- **No coordinator.** A hand-off waits for the next tick of the receiving agent.
- **Busy means wait once, never queue.** A tick whose agent is still running becomes the
  schedule's one deferred fire, retried every tick until it starts or the next occurrence
  comes ([busy policy](../schedules.md)).
- **Locks are labels.** Two runs could race between the label query and the swap; staggered
  schedules and `max_concurrent_per_agent: 1` keep one run per role, and the gate expires the
  locks a dead run leaves behind.
- **Headless runs end with the turn.** Anything left running in the background is killed,
  so the prompts forbid background tasks and require a push before the final message.
