# Development

## Getting started as a contributor

[CONTRIBUTING.md](../CONTRIBUTING.md) is the entry point: setup from a fresh clone to a green
`npm run check`, the rules a pull request must keep, branch naming, the issue and pull request
templates, and the `good first issue` label to start from. This page is the reference behind it.

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

Nothing is published from a laptop. `.github/workflows/release.yml` is the one the maintainer
runs, from the Actions tab (`workflow_dispatch` on `main`, input: the version). Its `tag` job
checks that `main` already carries that version (both packages and a dated
`## [<version>] - YYYY-MM-DD` section in `CHANGELOG.md`), creates the annotated tag `v<version>`
and the GitHub release with that section as its notes, then calls the `publish` job below for
the tag. GitHub never starts a workflow from a tag that a workflow's own token pushed, which is
why the release workflow calls publish.yml (`workflow_call`) instead of relying on the tag event.
Re-running it is safe: an existing tag or release is kept, a published version is skipped.

`.github/workflows/publish.yml` has two jobs:

- `publish`, called by release.yml with the tag, or on a tag `v*` pushed by hand: it first checks
  that the tag matches the `version` of **both**
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
Changed or Fixed). A release is one pull request, then the Release workflow run by the maintainer. In order,
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
4. **After the merge, run the Release workflow** (maintainer only): Actions tab, "Release (tag, GitHub
   release, npm publish)", "Run workflow" on `main`, version `0.2.0`. From the terminal:

   ```bash
   gh workflow run release.yml --ref main -f version=0.2.0
   gh run list --workflow release.yml --limit 1
   gh run watch <run id>
   ```

   It refuses to run when `main` does not carry the version or the CHANGELOG section is not
   dated, creates the annotated tag `v0.2.0` and the GitHub release with the CHANGELOG section
   as its notes, and runs the `publish` job ([Publishing](#publishing)). A failure after the
   first package published is fixed by dispatching the workflow again with the same version,
   even once `main` has moved on: when the tag exists, the checks and the notes read from the
   tag, the tag and the release are kept, and a version already on the registry is skipped.
5. **By hand, if the Actions tab is not an option:** an annotated tag
   (`git tag -a v0.2.0 -m "Duskfleet 0.2.0"`, then `git push origin v0.2.0`, which runs the
   `publish` job on its own) and `gh release create v0.2.0 --verify-tag --title "Duskfleet 0.2.0"
   --notes-file <notes file>` with the CHANGELOG section saved outside the repository.
6. **Verify from outside the repository**:

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

This repository's issues and PRs are planned, implemented and reviewed by Duskfleet agents through `flow:` labels, with a PR gate and a project board mirror;
roles, label state machine, schedules and example agent files: [How Duskfleet builds itself](self-hosting-development.md).

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
  | `-r, --resume <id>` | Passed instead of `--session-id` when a pass continues a session: the wrap-up pass after a budget exhaustion and a `resume_once` retry; also surfaced as the "resume this run" command |

  `duskfleet mcp register --target claude-code` runs one more command, `claude mcp add`, with
  the flags checked against `claude mcp add --help` on 2026-10-21:

  | Flag | Purpose in Duskfleet |
  |---|---|
  | `-s, --scope <local\|user\|project>` | `--scope user`: the server is available in every project |
  | `-e, --env <KEY=value...>` | `CLAUDE_BIN`, and `DUSKFLEET_CONFIG` when the server would not find its config. Variadic: it would take a following name as one more value, so the name goes right after `add` |
  | `<name> ... -- <command> [args...]` | Name `duskfleet` first, then the options, then `--` and the server command; stdio is the default transport |

  `duskfleet init` runs `claude auth status --json` (checked against `claude auth status --help`
  on 2026-10-21): JSON with a boolean `loggedIn` (and `authMethod`); a logged-out user gets
  `loggedIn: false` and exit 1. Output without a `loggedIn` boolean stops `init` as "could not
  read the login status". The fix it prints is `claude auth login`.

Keep these pages in sync when behaviour changes.
