# Development

## Repository layout

npm workspaces, three deliverables sharing one `config/` and one SQLite database:

```
duskfleet/
├── config/              declarative config: duskfleet.yaml, agents/*.md, projects.yaml (Git)
├── data/                runtime: duskfleet.db, logs/<run_id>.jsonl, agents/*.md (git-ignored)
├── packages/
│   ├── core/            @duskfleet/core — domain: config, storage, execution, orchestration, scheduler, evals
│   └── mcp/             @duskfleet/mcp  — MCP server (stdio) + CLI + tests
└── apps/
    └── web/             @duskfleet/web  — Next.js dashboard (read-only)
```

A local `playground/` directory is ignored by version control: put a throwaway project there
(or anywhere else) to use as a run target while trying things out, and register it in the
private `data/projects.yaml`.

`core` has no knowledge of MCP or React. `mcp` and `web` both depend on `core` and nothing else
from each other. The dashboard reads the database the MCP server writes (SQLite WAL allows this).

Three runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `yaml`), no native addons
(`node:sqlite`), no component library.

## Code map

```
packages/core/src/config         YAML/Markdown loaders, agent files, repo-root discovery
packages/core/src/storage        node:sqlite, migrations, RunRepository, schedules, lease
packages/core/src/execution      Executor interface, ClaudeCodeExecutor, stream-json parser
packages/core/src/orchestration  RunManager, state machine, project validation
packages/core/src/scheduler      cron parser, scheduler engine, lease
packages/core/src/observability  Run model
packages/core/src/evals          types + repository (foundation only)
packages/core/src/index.ts       public API of @duskfleet/core
packages/mcp/src/mcp             MCP server + tools (one file per tool group)
packages/mcp/src/cli.ts          local CLI
packages/mcp/src/index.ts        MCP server entry point
packages/mcp/test                fake Claude binary + tests
apps/web/app                     Next.js routes: /, /agents, /runs/[id], /schedules, /mcp
apps/web/lib/data.ts             server-only read access to config + SQLite
```

## Build and test

```bash
npm run build          # core + mcp (tsc). The CLI, the MCP server and the dashboard import from dist/
npm run typecheck      # core + mcp; dashboard: npm run typecheck -w @duskfleet/web
npm test               # packages/mcp/test/*.test.js, node --test, ~25 s, no network, no cost
npm run check          # everything CI runs, in the same order (hygiene, lint, build, typecheck, tests)
```

The tests use `packages/mcp/test/fake-claude.js`, a stand-in for the Claude binary that replays
the real `stream-json` event shapes, so they never launch a real Claude. They cover the
executor, state machine, SQLite storage, validation, scheduler, legacy database adoption and the
MCP server driven over stdio. Add a case to the fake binary when the parser learns a new event.

## Quality gates

Every pull request runs the `checks` job in `.github/workflows/ci.yml`; a ruleset on `main` refuses
the merge while it is red, refuses pushes that bypass a pull request, and requires a review from a
code owner (`.github/CODEOWNERS`: the maintainer owns every file, so a community pull request merges only
once they approve it; repository admins may bypass that requirement for their own pull requests). The job needs no Claude
login and spends nothing: the tests use the fake binary. In order:

| Step | Command | Fails when |
|------|---------|------------|
| Public-repo hygiene | `npm run check:public` | A versioned file contains a home path, the committing machine's user or host name, or the index holds a symlink. Placeholders `<you>`, `you`, `me` are fine. |
| Lint + format | `npm run lint` (`biome ci .`; `npm run lint:fix` repairs) | A Biome lint error or an unformatted file. Warnings (`noNonNullAssertion`, `noExplicitAny`, …) do not block. In `packages/core` an import of the MCP SDK, React or Next.js is an error. |
| Build | `npm run build` | `tsc` errors in core or mcp |
| Typecheck | `npm run typecheck`, `npm run typecheck -w @duskfleet/web` | Type errors anywhere |
| Tests + coverage | `npm run test:coverage` | A failing test, or line coverage of the in-process code under 80 % |
| Dashboard build | `npm run build:web` | `next build` errors (Server Component rules `tsc` does not see) |
| Audit | `npm audit --audit-level=high` | Report-only until the Next 16 upgrade clears the `postcss` advisory Next 15 pins; then blocking on high / critical. |

Two tests are gates in themselves: `test/migrations.test.js` pins the SHA-256 of every shipped
migration (edit one and it fails; add one and it tells you the digest to append), and the layering of
the three packages is a Biome rule, not just this page. Dependabot opens grouped weekly PRs for npm
and GitHub Actions. Not built yet: a periodic `claude --help` flag-drift check (needs the CLI, so a
local schedule rather than Actions), a manual-dispatch smoke run with `--model haiku`, and a docs
sync check (every MCP tool in `docs/mcp-server.md`, every `docs/` page linked from `README.md`).

## Issue and review flow by agents

The owner runs a development loop over this repository's own issues and PRs with three local
Claude Code agents and four local skills (`.claude/` is git-ignored: agents, skills and
settings stay on the machine). A DuskFleet run loads the project's skills (verified with Claude
Code 2.1.302: `--permission-prompts none` with `--setting-sources project,local` still mounts
`.claude/skills` and the built-in skills), so an agent only needs `Skill` in its
`allowed_tools`.

The state machine is a set of `flow:` labels on GitHub; there is no coordinator process.
Issues carry the development state, PRs carry the review state, and each agent finds its own
work from a label query when its schedule wakes it:

```
issue:  priority: * ──(planner, when unblocked)──► flow: ready ──(developer picks, swaps the label first)──► flow: in-progress ──► closed by the merge
PR:     flow: needs-review ──► flow: in-review ──► flow: changes-requested ──► flow: needs-review … ──► flow: ready-to-merge
```

- A human writes issues and sets their `priority:` labels; a priority is the consent for an
  issue to be developed. The planner fills the `flow: ready` queue from them (below), and a
  human can still label an issue `flow: ready` by hand. The developer takes `priority: high`
  first, then oldest. `flow: needs-human` parks anything the loop cannot decide;
  `flow: ready-to-merge` means a human merges — agents never do.
- The planner runs twice a day, read-only on files. `node scripts/issue-plan.mjs` prints a JSON
  snapshot of the flow (labels, declared blockers and whether they are still open, the open PRs
  closing each issue, a ranked candidate list); the agent then declares missing dependencies,
  parks issues that need a decision with `flow: needs-human`, and promotes candidates to
  `flow: ready` up to six, at most two units of work in flight per area, and none while eight
  PRs wait for a merge. It never promotes an issue without a `priority:` label, a `roadmap`
  issue, one that already has an open PR, or an `area: website` issue: the public site
  (`duskfleet-website`) is the owner's work, and the developer agents of this repository
  would build it into the dashboard.
- Dependencies are lines in an issue's body or comments: `Blocked by #65` (or
  `Depends on #62, #61`). While one of them is open the issue carries the `blocked` label and
  stays out of the queue; the planner removes the label once all of them are closed. A
  `blocked` label without such a line is a human's and is left alone. To drop a dependency,
  delete the line (the planner's are comments starting with `[df-planner]`).
- The developer does one unit of work per run, rework before new work: a PR labelled
  `flow: changes-requested` (or, as a fallback, an unlabelled PR with unresolved review
  threads) is fixed in a worktree on the PR branch (`scripts/pr-worktree.sh <name> <branch>
  <base>`), one commit pushed, every thread answered with a fixed prefix and resolved;
  otherwise the top `flow: ready` issue is implemented on a new `issue/<n>-<slug>` branch and
  opened as a PR whose body says `Closes #<n>`. Either way the PR is handed to the reviewer
  with `flow: needs-review`. Each pickup swaps the label first, as a lock against a second run.
- The reviewer picks the oldest PR labelled `flow: needs-review` (fallback: the oldest open PR
  without a `VERDICT:` comment naming its current head SHA), swaps it to `flow: in-review`,
  runs a correctness pass through a subagent with a fixed brief (it posts the findings that
  hold as inline comments), then checks the rules of CLAUDE.md — and, for a PR that closes an
  issue, the issue's own acceptance criteria — and posts one summary comment ending with
  `VERDICT: approve` or `VERDICT: changes`. The verdict's label (`flow: ready-to-merge` or
  `flow: changes-requested`) is the hand-off. Read-only agent; after three `VERDICT: changes`
  rounds it parks the PR with `flow: needs-human`. The built-in `code-review` skill is not
  used unattended: its fork gathers context with commands no allow-list can permit
  (`git diff @{upstream}...HEAD`, `;` chains), so it was denied in most runs.
- Dependabot PRs take a short path instead of the two passes: all checks green, only manifests,
  lockfile or workflow files changed, no added dependency, no major bump (and `@types/node`
  on the Node floor's major) → `flow: ready-to-merge`; a red check or a bump outside those
  bounds → `flow: changes-requested`, and a wanted major → `flow: needs-human`. Still a
  review: grouped bumps have broken the web build before.

- The PR gate keeps the labels true to the merge state, with no agent involved. A PR labelled
  `flow: needs-review` or `flow: ready-to-merge` was fine when it got the label; once `main`
  moves it can conflict, and the ruleset on `main` requires an up-to-date branch with a green
  `checks` job. `node scripts/pr-gate.mjs [--dry-run] [--update-branch]` reads every open PR
  in those two states (drafts and Dependabot excluded) and, when it conflicts with its base or
  a check failed on its head, posts one comment starting with `[pr-gate]` (head SHA and the
  reasons) and swaps the label to `flow: changes-requested`: the developer's next run merges
  the base into the branch or fixes the check, and hands the PR back to the reviewer as after
  any review. A PR that is merely behind its base is updated in place with `--update-branch`.
  Idempotent: a head that already carries a `[pr-gate]` comment is left alone, so a human can
  overrule the gate by relabelling. The workflow `.github/workflows/pr-gate.yml` runs it on
  every push to `main`, after every CI run, once an hour and on demand. With the repository
  secret `PR_GATE_TOKEN` (a user token with write access; scopes in the workflow header) it
  also updates branches and its label changes fire the project sync; with the default token it
  only relabels, since a push or a label set by `GITHUB_TOKEN` starts no other workflow. The
  reviewer checks the same state before and after its passes (`gh pr view <n> --json
  mergeable,statusCheckRollup`): a conflicting or red PR gets `VERDICT: changes` without a
  review.

The DuskFleet side is three user agents in `data/agents/` (developer, reviewer, planner) that
link the local Claude Code agents (`claude_agent`) and add only the unattended envelope:
permission mode, `gh` / `git` / `npm` allow-list, budget and timeout — plus one cron schedule
per agent, staggered so a PR opened by the developer meets the reviewer within the hour and a
planner run lands just before a developer tick. A busy agent makes a tick skip
(`skipped_busy`), never queue. See `docs/agents.md` and `docs/schedules.md`.

The GitHub Project "DuskFleet Flow" (org project 2) is a read-only mirror of the labels:
`node scripts/project-sync.mjs [--dry-run]` adds every open issue and PR to the project (the
project's auto-add workflow covers issues only) and sets each item's Status from its `flow:`
label (`Backlog` without one, `Done` when closed or merged). Labels stay the source of truth:
agents never touch the project, and a Status dragged on the board is overwritten on the next
sync. Its views: *Board* (open items by Status, Backlog hidden), *Backlog* (open issues with no
`flow:` label, to pick what to promote), *Needs me* (`Ready to merge` and `Needs human`, the two
states that wait for a human), *All*. Run by hand, the script needs the `project` scope once
(`gh auth refresh -h github.com -s project`). The workflow `.github/workflows/project-sync.yml`
runs it on every open / close / label change of an issue or PR, once an hour as a safety net
and on demand (*Actions → Project sync → Run workflow*); it needs the repository secret
`PROJECT_SYNC_TOKEN` (the default token cannot touch an organization project; the scopes are
listed in the workflow header). Without the secret the job fails loudly and the board simply
lags until the script is run by hand.

## Security model

- The project path is passed as the child's **working directory**; nothing is ever built into a
  shell string (`spawn(binary, argv, { shell: false })`).
- The prompt is written to the child's **stdin**, never passed as an argument: it does not show
  up in `ps` output nor in the recorded command, only in the run's `prompt` column.
- Project paths are validated before anything runs; `allowed_project_roots` fences them.
- Permission mode is explicit per agent; `bypassPermissions` is off unless enabled in config.
- Every run stores the full command it executed.
- Child processes inherit your environment (so Claude auth works) minus the variables that mark a
  nested Claude Code session.

## Extending

- **New MCP tool**: add a file in `packages/mcp/src/mcp/tools/`, register it in `packages/mcp/src/mcp/server.ts`.
- **New builtin agent**: drop a Markdown file in `config/agents/`.
- **Schema change**: append a migration in `packages/core/src/storage/db.ts`; never edit an existing one. Then pin its digest in `packages/mcp/test/migrations.test.js` (the failing test prints it).
- **Run status changes**: only `RunManager`, through `assertTransition`.
- **New dashboard view**: add a route under `apps/web/app/` and a query in `apps/web/lib/data.ts`.
- **Evals**: implement the interfaces in `packages/core/src/evals/types.ts`; the run pipeline does not need to change.
- **Claude CLI flags**: verify every flag against `claude --help` before using it. The ones the
  executor uses, checked against `claude --help` of Claude Code 2.1.285:

  | Flag | Purpose in DuskFleet |
  |---|---|
  | `-p, --print` | Non-interactive execution; with no positional prompt it reads the prompt from stdin (`--input-format` defaults to `text`), which is how the executor sends it |
  | `--output-format stream-json` + `--verbose` | Line-delimited JSON events (`stream-json` refuses to run without `--verbose`) |
  | `--session-id <uuid>` | The run knows its session id before the process starts |
  | `--model <model>` | Only passed when explicitly selected |
  | `--permission-mode <mode>` | `acceptEdits`, `auto`, `manual`, `dontAsk`, `plan` (`bypassPermissions` is refused unattended) |
  | `--permission-prompts none` | Unattended: anything that would prompt is denied instead of blocking |
  | `--allowedTools` / `--disallowedTools` | Per-agent tool policy |
  | `--append-system-prompt <text>` | Agent definition body becomes the appended system prompt |
  | `--agent <name>` | Link agents: run as the project's `.claude/agents/<name>.md` |
  | `--max-budget-usd <amount>` | Hard cost cap per run |
  | `--effort <level>` | Optional per-agent effort |
  | `--strict-mcp-config` | Isolate the child from user-level MCP servers (default on, configurable) |
  | `--add-dir <dir>` | `add_dirs`: extra directories the run may touch |
  | `--setting-sources <list>` | Restrict which settings files the child loads (`claude.setting_sources`) |
  | `-r, --resume <id>` | Not used by the executor; surfaced as the "resume this run" command |

Keep these pages in sync when behaviour changes.
