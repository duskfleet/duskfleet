# Development

## Repository layout

npm workspaces, three deliverables sharing one `config/` and one SQLite database:

```
duskfleet/
├── config/              declarative config: duskfleet.yaml, agents/*.md, projects.yaml (Git)
├── data/                runtime: duskfleet.db, logs/<run_id>.jsonl, agents/*.md (git-ignored)
├── packages/
│   ├── core/            @duskfleet/core — domain: config, storage, execution, orchestration, scheduler, evals
│   ├── mcp/             @duskfleet/mcp  — MCP server (stdio) + CLI + tests
│   └── duskfleet/       duskfleet       — the published npm package: mcp + core bundled (no source)
└── apps/
    └── web/             @duskfleet/web  — Next.js dashboard (read-only), published too
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
packages/mcp/src/cli.ts          CLI bin: Node version check, then cli-main.ts (the local CLI)
packages/mcp/src/index.ts        MCP server bin: Node version check, then server-main.ts
packages/mcp/src/node-version.ts the Node 24 gate; no imports, loads on old runtimes
packages/core/test               unit tests of core modules (nothing spawned)
packages/mcp/test                fake Claude binary + end-to-end tests
apps/web/app                     Next.js routes: /, /agents, /runs/[id], /schedules, /mcp
apps/web/lib/data.ts             server-only read access to config + SQLite
```

## Build and test

```bash
npm run build          # core + mcp (tsc). The CLI, the MCP server and the dashboard import from dist/
npm run typecheck      # core + mcp; dashboard: npm run typecheck -w @duskfleet/web
npm test               # packages/core/test, then packages/mcp/test; node --test, ~25 s, no network, no cost
npm test -w @duskfleet/core   # core unit tests alone, under a second
npm run check          # everything CI runs, in the same order (hygiene, lint, build, pack, typecheck, tests)
```

## Published packages

Two packages go to npm, always at the same version (one bump touches both `package.json` files):

- `duskfleet` (`packages/duskfleet`): the `duskfleet` and `duskfleet-mcp` bins, for
  `npx duskfleet`. It has no source of its own: `npm run build` ends with
  `scripts/assemble-package.mjs`, which copies the built `packages/mcp/dist` to
  `packages/duskfleet/dist` and `packages/core/dist` to `dist/core` (`.js` and `tools.json` only),
  and rewrites the `@duskfleet/core` imports into relative paths. `@duskfleet/core` and
  `@duskfleet/mcp` stay private and are never published; the runtime dependencies of `duskfleet`
  must equal those of core + mcp (the script fails otherwise). A thin package rather than renaming
  `packages/mcp`: the workspace keeps importing `@duskfleet/core` and the tests keep running on
  `packages/mcp/dist`, and only the copy is rewritten. The script also writes the npm copy of
  `README.md`: relative image paths become `raw.githubusercontent.com` URLs (so the banner renders
  on npmjs.com), relative links become GitHub URLs, and the duskfleet.com links carry
  `utm_source=npm` instead of the GitHub parameters. Both manifests carry `homepage`,
  `repository` (with `directory`) and `bugs`.
- `@duskfleet/web` (`apps/web`): the built dashboard (`.next/`, `public/`, `next.config.mjs`, and
  `tools.json`, the MCP catalogue copied from `packages/mcp/dist` by `scripts/copy-tools.mjs` at
  the end of its build, so run `npm run build` first) and
  `bin/start.mjs` (bin `duskfleet-web`), which runs `next start` on 127.0.0.1 (`PORT`, default
  4777) and passes the working directory and the environment through, so `DUSKFLEET_CONFIG`
  points it at a config. Core is bundled into the server build by Next (it is not a
  `serverExternalPackages` entry), so `@duskfleet/core` is only a dev dependency.

`npm run check:pack` (`scripts/check-pack.mjs`) runs `npm pack --dry-run` on both and fails on a
file outside the allow-list, test files, source maps, `data/`, `.env*`, `@duskfleet/core` in a
published dependency field, or two different versions; it prints both tarball sizes. To try the
real thing: `npm pack -w duskfleet`, then `npx ./duskfleet-0.1.0.tgz --help` from another directory.

### Publishing

Nothing is published from a laptop. `.github/workflows/publish.yml` has two jobs:

- `publish`, on a pushed tag `v*`: it first checks that the tag matches the `version` of **both**
  packages (`v0.1.0` and `"0.1.0"`) and fails before anything else otherwise, then runs `npm ci`,
  `npm run check`, `npm run build:web` and `npm run check:pack -- --require-web-build`, and
  publishes `duskfleet`, then `@duskfleet/web`, with `npm publish --provenance --access public`
  from their package directories. The job has `id-token: write` (npm signs the provenance
  statement through GitHub's OIDC token) and takes `NODE_AUTH_TOKEN` from the `NPM_TOKEN`
  repository secret, a granular npm token that can publish those two packages only. A version
  already on the registry is skipped, so re-running a release whose second publish failed
  finishes it. Provenance requires each `package.json` `repository` to name this repository.
- `publish dry-run`, on every pull request: the same steps without a token, ending in
  `npm publish --dry-run` for both packages, so a broken pack shows up before the tag. Instead of
  the tag guard it checks that the two versions are equal.

Like every workflow here, it pins its actions by commit SHA.

One home per module: a test that only calls core functions (state machine, loader, parser, cron,
tool summaries) lives in `packages/core/test` and imports `@duskfleet/core`; a test that needs the
CLI, the MCP server or a spawned fake Claude lives in `packages/mcp/test`. Both import the built
`dist/`, so run `npm run build` first. `npm run test:coverage` runs both suites in one process set,
so the 80 % gate still counts the core tests.

The tests use `packages/mcp/test/fake-claude.js`, a stand-in for the Claude binary that replays
the real `stream-json` event shapes, so they never launch a real Claude. They cover the
executor, state machine, SQLite storage, validation, scheduler, legacy database adoption and the
MCP server driven over stdio. Add a case to the fake binary when the parser learns a new event.

## Releasing

`CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) is the release notes:
every user-facing pull request adds a line, linking itself, under `## [Unreleased]` (Added,
Changed or Fixed). A release is one pull request, then a tag pushed by the maintainer. In order,
with `0.2.0` standing for the new version:

1. **Bump the version, in one commit on a branch.** Set `"version": "0.2.0"` in all five
   `package.json` files (`package.json`, `packages/core`, `packages/mcp`, `packages/duskfleet`,
   `apps/web`) and the two exact `"@duskfleet/core": "0.2.0"` pins (in `packages/mcp` and
   `apps/web`), then refresh the lockfile:

   ```bash
   npm install --package-lock-only
   npm run check:pack     # fails if duskfleet and @duskfleet/web differ
   ```

2. **Date the changelog.** Rename `## [Unreleased]` to `## [0.2.0] - YYYY-MM-DD` (the day of the
   tag), add a new empty `## [Unreleased]` above it, and update the two link lines at the bottom
   (`[Unreleased]` compares `v0.2.0...HEAD`, `[0.2.0]` points to the release tag).
3. **Open the pull request** with both commits and the release notes (the CHANGELOG section
   without its heading) in its description; `npm run check` must pass, and the `publish dry-run`
   job proves the packages build and pack.
4. **After the merge, tag `main`** (maintainer only, annotated tag):

   ```bash
   git switch main
   git pull --ff-only
   git tag -a v0.2.0 -m "Duskfleet 0.2.0"
   git push origin v0.2.0
   ```

5. **Create the GitHub release** from that tag, with the CHANGELOG section as its notes (save it
   to a file first, outside the repository):

   ```bash
   gh release create v0.2.0 --verify-tag --title "Duskfleet 0.2.0" --notes-file <notes file>
   ```

6. **Watch the publish.** The tag runs the `publish` job of `.github/workflows/publish.yml`
   ([Publishing](#publishing)): `gh run list --workflow publish.yml --limit 1`, then
   `gh run watch <run id>`. A failure after the first package published is fixed by re-running
   the job: a version already on the registry is skipped.
7. **Verify from outside the repository**:

   ```bash
   npx duskfleet@latest --version        # prints 0.2.0
   npm view @duskfleet/web version       # prints 0.2.0
   ```

For `0.1.0` the versions already read `0.1.0`: skip step 1, and set the date of its CHANGELOG
section to the day of the tag if it differs.

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
| Docs sync | `npm run check:docs` (after the build: it reads `packages/mcp/dist/tools.json`) | An MCP tool the server registers has no row in `docs/mcp-server.md`, a `ScheduleOutcome` value is not listed there, a `docs/*.md` page is not linked from `README.md`, or the README's tool count is stale. |
| README Quick start | `npm run check:quickstart` (after the build: `scripts/check-quickstart.mjs` drives `packages/mcp/dist/cli.js`) | A `npm run cli -- ...` line of the README Quick start exits non-zero when replayed against `fake-claude.js` (temporary copy of `config/`, scratch project with a failing test), `run` does not record a completed run, `runs` does not list it, a `doctor` / `agents create` / `run` / `runs` step is gone, or a new line is neither replayed nor on the script's skip list. |
| Typecheck | `npm run typecheck`, `npm run typecheck -w @duskfleet/web` | Type errors anywhere |
| Tests + coverage | `npm run test:coverage` | A failing test, or line coverage of the in-process code under 80 % |
| Dashboard build | `npm run build:web` | `next build` errors (Server Component rules `tsc` does not see) |
| Pack check | `npm run check:pack -- --require-web-build` | A published tarball holds a file outside its allow-list (tests, maps, `data/`, `.env*`), lists `@duskfleet/core` as a dependency, misses the dashboard build, or the two versions differ. `npm run check` runs it without the flag: an unbuilt dashboard is only a warning there. |
| Packed CLI smoke | `npm pack -w duskfleet`, then `npx ./duskfleet-*.tgz --help` outside the repository | The tarball does not install or its CLI does not start. |
| Audit | `npm audit --audit-level=high` | Report-only until the Next 16 upgrade clears the `postcss` advisory Next 15 pins; then blocking on high / critical. |

Two tests are gates in themselves: `test/migrations.test.js` pins the SHA-256 of every shipped
migration (edit one and it fails; add one and it tells you the digest to append), and the layering of
the three packages is a Biome rule, not just this page. Dependabot opens grouped weekly PRs for npm
and GitHub Actions. Workflows pin every action by full commit SHA with a version comment
(`uses: actions/checkout@<sha> # v7.0.1`); Dependabot bumps the SHA and the comment together. Not built yet: a periodic `claude --help` flag-drift check (needs the CLI, so a
local schedule rather than Actions) and a manual-dispatch smoke run with `--model haiku`.

## Issue and review flow by agents

The owner runs a development loop over this repository's own issues and PRs with three local
Claude Code agents and four local skills (`.claude/` is git-ignored: agents, skills and
settings stay on the machine). A Duskfleet run loads the project's skills (verified with Claude
Code 2.1.302: `--permission-prompts none` with `--setting-sources project,local` still mounts
`.claude/skills` and the built-in skills), so an agent only needs `Skill` in its
`allowed_tools`.

The state machine is a set of `flow:` labels on GitHub; there is no coordinator process.
Issues carry the development state, PRs carry the review state, and each agent finds its own
work from a label query when its schedule wakes it:

```
issue:  priority: * ──(planner, when unblocked)──► flow: ready ──(developer picks, swaps the label first)──► flow: in-progress ──► closed by the merge
PR:     flow: needs-review ──► flow: in-review ──► flow: changes-requested ──► flow: needs-review … ──► flow: ready-to-merge
fork PR:                        flow: in-review ──► flow: contributor-changes ──(contributor pushes; PR gate)──► flow: needs-review …
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

- The PR gate keeps the labels true to the merge state, with no agent involved. A PR labelled
  `flow: needs-review` or `flow: ready-to-merge` was fine when it got the label; once `main`
  moves it can conflict, and the ruleset on `main` requires an up-to-date branch with a green
  `checks` job. `node scripts/pr-gate.mjs [--dry-run] [--update-branch]` reads every open PR
  in those two states (drafts and Dependabot excluded) and, when it conflicts with its base or
  a required check (read from the rulesets on the base branch; a failed non-required job such
  as `sync` does not count) failed on its head, swaps the label to `flow: changes-requested`
  (`flow: contributor-changes` for a PR from a fork) and then posts one comment starting with `[pr-gate]` (head SHA and the reasons; it is
  written last, so a failed label call is retried on the next run). One failing PR does not
  stop the others; the script exits non-zero at the end. The developer's next run merges
  the base into the branch or fixes the check, and hands the PR back to the reviewer as after
  any review. A PR that is merely behind its base is updated in place with `--update-branch`.
  Idempotent: a head that already carries a `[pr-gate]` comment is left alone, so a human can
  overrule the gate by relabelling. A PR labelled `flow: contributor-changes` with a commit on
  its head newer than the label goes back to `flow: needs-review` with a `[pr-gate]` comment:
  the contributor answered, the reviewer looks again. The workflow `.github/workflows/pr-gate.yml` runs it on
  every push to `main`, after every CI run, once an hour and on demand. With the repository
  secret `PR_GATE_TOKEN` (a user token with write access; scopes in the workflow header) it
  also updates branches and its label changes fire the project sync; with the default token it
  only relabels, since a push or a label set by `GITHUB_TOKEN` starts no other workflow. The
  reviewer checks the same state before and after its passes (`gh pr view <n> --json
  mergeable,statusCheckRollup`): a conflicting or red PR gets `VERDICT: changes` without a
  review.
- The gate also expires stale locks. `flow: in-progress` and `flow: in-review` are swapped in
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
  only at the start of a line); an issue `in-progress` with no open PR
  closing it to `flow: ready`. Each gets a `[pr-gate]` comment naming the lock and its age. A
  pickup is a new label event, so the clock restarts and a run still at work is never
  interrupted. Agents keep their side of it: swap the label first, push or post before the
  timeout, never end a run with work "still running in the background".

The Duskfleet side is three user agents in `data/agents/` (developer, reviewer, planner) that
link the local Claude Code agents (`claude_agent`) and add only the unattended envelope:
permission mode, `gh` / `git` / `npm` allow-list, budget and timeout — plus one cron schedule
per agent, staggered so a PR opened by the developer meets the reviewer within the hour and a
planner run lands just before a developer tick. A busy agent makes a tick skip
(`skipped_busy`), never queue. See `docs/agents.md` and `docs/schedules.md`.

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

## Traffic snapshots

GitHub keeps a repository's traffic (views, clones, referrers, popular paths) for 14 days only.
`node scripts/traffic-snapshot.mjs [--repo <owner/name>] [--out <dir>]` reads the four
traffic endpoints through the local `gh` login (`gh api`, no token in the repo or in `config/`)
and writes them into one file, `data/traffic/<owner>/<name>/<YYYY-MM-DD>.json` (UTC date,
git-ignored; `--out` replaces `data/traffic`). `--repo` defaults to `duskfleet/duskfleet`, so
the website repository is `--repo duskfleet/duskfleet-website`. Every day keeps its own file; a
second run on the same day overwrites that day's file, since the later answer covers the same
window plus the hours since. The traffic API needs push access: without a `gh` login, with an
invalid token or with a read-only one the script exits 1 with a message naming the cause.

Run it at least once every 14 days. A weekly Duskfleet schedule does it, for example cron
`0 9 * * 1` (Mondays 09:00) on an agent whose prompt runs the script once per repository and
whose `allowed_tools` are `Bash(node scripts/traffic-snapshot.mjs:*)` and `Bash(gh api:*)`
(permission mode `dontAsk`, a small budget, `model: haiku`). The owner creates the schedule;
nothing in the repo runs it.

## Security model

See [What Duskfleet does and does not confine](security.md) for verified execution boundaries,
local run-data handling, and recommended configuration.

## Extending

- **New MCP tool**: add a file in `packages/mcp/src/mcp/tools/`, register it in `packages/mcp/src/mcp/server.ts`.
- **New builtin agent**: Duskfleet ships no starter or default agent (a user's first agent comes
  from `agents create` or `create_agent`), so a builtin is only ever a specialised pattern nobody
  runs without naming it. Drop a Markdown file in `config/agents/` and list it under "Builtin
  agents" in `docs/agents.md`. Builtins are general-purpose (no `project:`, no `add_dirs`, no
  personal paths); `packages/core/test/builtin-agents.test.js` checks it.
- **Schema change**: append a migration in `packages/core/src/storage/db.ts`; never edit an existing one. Then pin its digest in `packages/mcp/test/migrations.test.js` (the failing test prints it).
- **Run status changes**: only `RunManager`, through `assertTransition`.
- **New dashboard view**: add a route under `apps/web/app/` and a query in `apps/web/lib/data.ts`.
- **Evals**: implement the interfaces in `packages/core/src/evals/types.ts`; the run pipeline does not need to change.
- **Claude CLI flags**: verify every flag against `claude --help` before using it. The ones the
  executor uses, checked against `claude --help` of Claude Code 2.1.285:

  | Flag | Purpose in Duskfleet |
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
