# Contributing to Duskfleet

Thanks for helping. This page takes you from a fresh clone to a merged pull request. You should
not need to read anything else to get a green `npm run check`. When you want more depth, the
[Development](docs/development.md) page covers the code map, the quality gates and the release
process.

## Where to start

Issues labelled
[`good first issue`](https://github.com/duskfleet/duskfleet/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are small, well-scoped and a good way into the codebase. Before you start one, check that it does
not already carry `flow: in-progress` or have an open pull request: someone is already on it.
Leave a comment saying you are taking it.

To report a bug, ask for a feature or fix the docs, open an issue from one of the templates.
Report security problems privately, as [SECURITY.md](SECURITY.md) explains, never in a public
issue.

## Set up

Requirements: Node.js **24 or newer** (Duskfleet uses the built-in `node:sqlite`; `.nvmrc` and
`.node-version` pin it) and Git. You do not need a Claude Code login to build and test: the tests
never launch a real Claude.

```bash
git clone https://github.com/<you>/duskfleet.git   # your fork
cd duskfleet
npm install
npm run check
```

If `npm install` fails with `EACCES` on your npm cache (a cache with files owned by another user),
point it at a fresh cache instead of fixing permissions: `npm install --cache "$TMPDIR/npm-cache"`.

`npm run check` runs what CI runs, in the same order. When it passes locally, the `checks` job
on your pull request passes too.

## Everyday commands

```bash
npm run build          # core + mcp (tsc) and the published package. Rebuild after every change
                       # under packages/: the CLI, the MCP server, the dashboard and the tests
                       # all import from dist/
npm run typecheck      # core + mcp; dashboard: npm run typecheck -w @duskfleet/web
npm test               # node --test, about a minute, no network, no cost
npm run lint           # Biome, the only lint and format tool (biome ci .)
npm run lint:fix       # Biome: format + safe fixes
npm run check          # check:public, lint, build, check:docs, check:pack, typecheck, test
npm run web            # dashboard on http://localhost:4777
```

`npm run check:public` fails when a versioned file contains a home path, your user or host name,
or the index holds a symlink. This repository is public: use placeholders such as `<you>` or
`/abs/path/to/project` in docs and examples.

## Rules that matter for a pull request

- **Three runtime dependencies**: `@modelcontextprotocol/sdk`, `zod` and `yaml`. No new runtime
  dependency, no native addon, no new framework. Dev dependencies need a good reason too.
- **Biome is the only lint and format tool**. Do not add Prettier or ESLint configs. In
  `packages/core`, importing the MCP SDK, React or Next.js is a lint error: core knows nothing
  about the MCP server or the dashboard.
- **Tests never launch a real Claude.** `packages/mcp/test/fake-claude.js` stands in for the
  `claude` binary and replays the real `stream-json` event shapes. When the parser learns a new
  event, add a case there. Tests that only call core functions go in `packages/core/test`; tests
  that spawn the CLI, the MCP server or the fake Claude go in `packages/mcp/test`.
- **Schema changes are new migrations.** Append an entry to the list in
  `packages/core/src/storage/db.ts` and never edit a shipped one. `test/migrations.test.js` fails
  and prints the digest you need to pin.
- **Docs stay in sync.** When behaviour changes, update `README.md` or the matching page in
  `docs/`. `npm run check:docs` catches a missing MCP tool row, a docs page that the README does
  not link, and a stale tool count.
- **Real runs cost money.** You do not need one for a normal change. If you have to verify
  something against a real Claude, use `--model haiku` (a few cents). Say so in the pull
  request and give the cost. An agent without an explicit model uses the Claude Code default,
  which can cost a hundred times more.

## Branches and pull requests

- Work on a branch of your fork, named `issue/<number>-<short-slug>` when it closes an issue
  (`issue/42-doctor-node-version`), and open the pull request against `main`.
- One unit of work per pull request: one issue, one fix or one docs change. Split unrelated
  changes.
- `npm run check` is green. The `checks` job must pass before anything can be merged.
- The pull request template asks what changed and why, how you verified it, whether the docs are
  updated and whether a real (paid) run was needed. Write `Closes #<number>` in the body when the
  pull request closes an issue.

## How a pull request gets reviewed

The maintainer reviews pull requests with Duskfleet's own agents, coordinated by `flow:`
labels. A planner agent picks up your pull request and labels it `flow: needs-review`. A
reviewer agent then posts inline comments and a summary, and labels the pull request either
`flow: contributor-changes` (your turn: push a fix and it goes back to review on its own) or
`flow: ready-to-merge`, after which a human merges it. Please leave the `flow:` labels alone.
The full state machine is in [Development](docs/development.md#issue-and-review-flow-by-agents).

## License

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE) of
this project.
