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
the merge while it is red, and refuses pushes that bypass a pull request. The job needs no Claude
login and spends nothing: the tests use the fake binary. In order:

| Step | Command | Fails when |
|------|---------|------------|
| Public-repo hygiene | `npm run check:public` | A versioned file contains a home path, the committing machine's user or host name, or the index holds a symlink. Placeholders `<you>`, `you`, `me` are fine. |
| Lint + format | `npm run lint` (`biome ci .`; `npm run lint:fix` repairs) | A Biome lint error or an unformatted file. Warnings (`noNonNullAssertion`, `noExplicitAny`, …) do not block. In `packages/core` an import of the MCP SDK, React or Next.js is an error. |
| Build | `npm run build` | `tsc` errors in core or mcp |
| Typecheck | `npm run typecheck`, `npm run typecheck -w @duskfleet/web` | Type errors anywhere |
| Tests + coverage | `npm run test:coverage` | A failing test, or line coverage of the in-process code under 80 % |
| Dashboard build | `npm run build:web` | `next build` errors (Server Component rules `tsc` does not see) |
| Audit | `npm audit --audit-level=high` | A high or critical advisory in the lockfile |

Two tests are gates in themselves: `test/migrations.test.js` pins the SHA-256 of every shipped
migration (edit one and it fails; add one and it tells you the digest to append), and the layering of
the three packages is a Biome rule, not just this page. Dependabot opens grouped weekly PRs for npm
and GitHub Actions. Design and the list of gates not yet built: [PLAN.md §8](../PLAN.md#8-quality-gates-added-2026-10-17).

## Security model

- The project path is passed as the child's **working directory**; nothing is ever built into a
  shell string (`spawn(binary, argv, { shell: false })`).
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
- **Claude CLI flags**: verify every flag against `claude --help` before using it; `PLAN.md` §1 lists the ones verified so far.

The design document is [PLAN.md](../PLAN.md); keep it and these pages in sync when behaviour changes.
