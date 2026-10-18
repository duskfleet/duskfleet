# DuskFleet

Local platform that orchestrates, observes and (later) schedules and evaluates autonomous
Claude Code agents. An MCP server (stdio) spawns `claude -p --output-format stream-json`
with a target project as cwd and records every run in SQLite. The design notes are private
(not in the repo). User docs: `README.md` (short entry page) and `docs/*.md` (one page per
topic). Keep them in sync when behaviour changes.

## Commands

```bash
npm install --cache "$TMPDIR/npm-cache"   # ~/.npm has root-owned files on this machine
npm run build        # core + mcp (tsc). Run after every change under packages/: the CLI,
                     # the MCP server and the dashboard all import from dist/
npm run typecheck    # core + mcp;  web: npm run typecheck -w @duskfleet/web
npm test             # packages/mcp/test/*.test.js, node --test, ~25 s, no network, no cost
npm run cli -- doctor | agents | projects | run | runs | run-info | schedules
npm run cli -- serve  # long-running scheduler process; the MCP server also ticks
npm run cli -- install-service [--print] | uninstall-service   # register `serve` with launchd / systemd --user / Task Scheduler
npm run cli -- run --project <project id or abs path> --agent <agent id> --model haiku -- "task"
npm run web          # Next.js dashboard, http://localhost:4777
npm run check        # what CI runs, same order: check:public, lint (biome ci), build, typecheck, test
npm run lint:fix     # Biome: format + safe fixes
```

Every PR must pass the `checks` job (`.github/workflows/ci.yml`); a ruleset on `main` blocks the
merge otherwise. Gates and rationale: docs/development.md "Quality gates".

Node 24+ is required (built-in `node:sqlite`). The MCP server entry is
`packages/mcp/dist/index.js`; it is registered for this repo in `.mcp.json` and in
Claude Desktop's config. Both hosts keep the process alive: after `npm run build`,
restart the host (or the Claude Code session) to load new code. Config under `config/`
needs no restart: it is re-read on every run and every `list_*` tool call.

## Layout

npm workspaces, one `config/` and one SQLite database shared by three deliverables:

- `packages/core` (`@duskfleet/core`): config loader, storage, execution (Claude Code
  executor + stream-json parser), orchestration (`RunManager`), evals and scheduler types.
  Must not import anything from MCP or React.
- `packages/mcp` (`@duskfleet/mcp`): MCP server, CLI, tests. One file per tool group in
  `src/mcp/tools/`; register it in `src/mcp/server.ts`.
- `apps/web` (`@duskfleet/web`): Next.js 15 dashboard. Reads the DB the server writes (WAL
  mode). Never mutates runs or builtins; its only writes are server actions on user agent
  files (`app/agents/actions.ts`: delete, unlink) and on schedule rows
  (`app/schedules/actions.ts`: pause/resume, cron + time zone, delete, run now, through core's
  `updateSchedule` / `requestRun`; run now only stamps `run_requested_at`, the lease holder
  fires it on its next tick). No auth, localhost only.
- `config/`: `duskfleet.yaml`, `agents/*.md` (builtin agents: YAML frontmatter + system
  prompt body), `projects.yaml` (repo-relative examples only). Meant to be committed.
  **This repo is public: no usernames, home paths or machine-specific values in versioned
  files, docs or examples** (`npm run check:public` enforces it in CI; placeholders `<you>`, `me` are fine). Personal projects live in `data/projects.yaml`, personal agents
  in `data/agents/`, the MCP registration in `.mcp.json` (all git-ignored).
- `data/`: `duskfleet.db`, `logs/<run_id>.jsonl` and `agents/*.md` (user agents written by
  `create_agent`; same id as a builtin overrides it). Git-ignored runtime state. Code must
  never write into `config/agents`; agent file I/O lives in `core/src/config/agent-files.ts`.
- `playground/`: ignored scratch directory for a local run target when trying things out.
  Not part of the repo; register it in the private `data/projects.yaml` if needed.
- `notes/`: private, never committed (`.gitignore`): daily journal (`notes/journal/daily/`),
  `notes/TODO.md` (backlog and launch plan) and research notes. The Obsidian vault is the repo
  root; `.obsidian/` is ignored too. Nothing in `notes/` may be referenced from versioned files.

## Rules

- Scheduler (`packages/core/src/scheduler/`): schedules are DB rows (migration 4), cron is the
  in-house 5-field parser in `cron.ts` (no dependency; DST-safe by re-deriving local time per
  candidate minute). Only the SQLite lease holder ticks; the holder is `<role>@host:pid`
  (`serve` / `mcp` / `cli`, `parseHolder`). Busy = `skipped_busy`, never a queue;
  no catch-up of missed ticks; `scheduler.enabled` is the kill switch read every tick.
  Create/update validation is `scheduler/crud.ts`, shared by MCP, CLI and dashboard.
  `install-service` (`packages/mcp/src/service.ts`) renders a per-user unit (launchd,
  systemd --user, Task Scheduler XML) from machine paths: never version a unit, re-run it
  after every build (it restarts the service). Not the OS crontab.

- **Verify every `claude` CLI flag against `claude --help` before using it.** Flags change
  between versions; `docs/development.md` lists the ones verified so far.
- Keep it small: three runtime deps (`@modelcontextprotocol/sdk`, `zod`, `yaml`), no
  native addons, no new frameworks. The owner evolves this code by hand. Biome is the only
  lint/format tool (`biome.json`); core importing the MCP SDK, React or Next.js is a lint error.
- `RunManager` is the only place that changes a run's status; go through
  `assertTransition`. Schema changes are new entries in the migrations list in
  `packages/core/src/storage/db.ts`, never edits to existing ones; `test/migrations.test.js`
  pins each shipped migration's digest and tells you the one to append for a new version.
- Tests never launch a real Claude: `packages/mcp/test/fake-claude.js` replays the
  verified stream-json shapes. Add a case there when the parser learns a new event.
- Real runs cost money. When one is needed to verify something, use `--model haiku`
  (cents) and say so. An agent without an explicit model uses the CLI default,
  which can be 100x more expensive.
- Dashboard: no component library, design tokens live in `apps/web/app/globals.css`
  (dark and light). A completed run that hit a permission denial is "needs review"
  (amber), never plain green.

## Things that bite

- **`plan` mode is useless unattended**: it blocks Bash, MCP and writes regardless of
  allow-lists (verified 2026-10-08). Read-only agents use `dontAsk` + `disallowed_tools:
  [Edit, Write, NotebookEdit]`. `bypassPermissions` is refused by Claude Code with
  `--permission-prompts none`; the executor throws before spawning.
- **`--permission-prompts none` ignores the target project's `.claude/settings` allow-lists**
  and confines file tools (and Bash paths) to the project directory. Everything an agent
  needs must be in its own `allowed_tools`; use `add_dirs` to reach other directories.
- **Runs have an owner** (`runs.owner`, `role@host:pid` from `processIdentity`, migration 7):
  several DuskFleet processes share the DB, so `recoverOrphans` (startup and the lease holder's
  once-a-minute sweep) fails a `running` row only when its owner is gone (dead pid on this host,
  NULL owner, or this pid without the run in memory), never a live process's or another host's.
- **Agents can be bound to a project** (`project: <id>`): grouped, default target, refused
  elsewhere. `create_agent`/`update_agent` validate the spec *before* writing, and roll the
  file back if the config no longer loads: one bad agent file would otherwise break every
  later config reload.
- **Two agent kinds, always explicit**: `own` (persona written here, body = system prompt,
  no `claude_agent`) or `link` (`claude_agent` + a project folder given as `project_path` or a
  registered `project` id; runs as `claude --agent <name>` in that folder using its
  `.claude/agents/<name>.md`; DuskFleet owns only the unattended envelope). A folder that is
  not a project yet is registered in the private registry by `create_agent`. `create_agent` requires `kind` and `assertAgentKind` in core validates the
  combination before any file is written. Prefer link when the project already has the agent.
- **Concurrency guards live in `RunManager.startRun`**: one run per project directory and
  one per agent by default (`max_concurrent_per_project`, `max_concurrent_per_agent`).
  Refuse, never queue; a scheduler must treat "busy" as "skip this tick".
- **Subagents are rows, not prose** (`run_agents`, migration 5): the parser folds Claude Code's
  `task_started` / `task_notification` lines and the `agent_id` of nested messages into one
  `SubagentRecord` per Agent call; `RunManager` writes them on `subagent_start` / `subagent_end`
  and marks the open ones `interrupted` when the run ends. Per-message `output_tokens` of nested
  lines undercount; use `totalTokens`. Only main-session lines set the run's model and last text.
- **`contextExhausted` is structured-only** (terminal reason / subtype / stop reason, or
  the error text of a failed run). Never scan a successful result's prose: it produced a
  false positive.
- **MCP**: runs are `--strict-mcp-config` (no servers) unless the agent or project sets
  `inherit_mcp: true`; then they get the user's claude.ai connectors with tool prefixes
  `mcp__claude_ai_Atlassian_Rovo__*`, `mcp__claude_ai_Figma__*` (not the `mcp__plugin_*`
  names interactive sessions may show). Allow-list by server: `mcp__claude_ai_Figma`.

- **Unattended runs get no permission prompts.** `permission_mode: acceptEdits` does
  not allow Bash; an agent that must run tests needs `allowed_tools` such as
  `Bash(npm test:*)` in its frontmatter, otherwise it ends with a permission denial.
- **User-level Stop hooks hang headless children.** `claude.setting_sources:
  [project, local]` in `config/duskfleet.yaml` makes child sessions skip
  `~/.claude/settings.json`. Keep it unless the hook is removed.
- Children run with `--strict-mcp-config`: they never see the caller's MCP servers,
  so DuskFleet cannot recurse into itself.
- Project paths must be absolute (`~` is expanded). Prefer `project_id` from
  `config/projects.yaml` in prompts and docs.
- Scripts that import `@modelcontextprotocol/sdk` must live under `packages/mcp/` to
  resolve the module.
- Renamed from Gab Factory on 2026-10-11. `openDatabase` adopts a legacy `data/gabfactory.db`
  (with WAL files) on first open; keep that shim until the old name is forgotten.
- Git: public repo `github.com/duskfleet/duskfleet`, branch `main`, first commit 2026-10-11.
  Git commands that write `.git` fail inside the sandbox; run them outside it.

## Roadmap

Next: scheduler (`packages/core/src/scheduler/types.ts` is the contract, no implementation),
then deterministic evals (`tests_passed`, `build_passed`, `files_exist`) as post-run hooks,
then LLM evals as a second read-only run, then metrics tools and Git integration. A Codex CLI
executor as a second runtime is assessed in the design notes (after evals).
