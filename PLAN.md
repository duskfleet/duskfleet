# DuskFleet — Implementation Plan

DuskFleet is a local platform for orchestrating, scheduling, observing and evaluating
autonomous coding agents that run on top of Claude Code.

```
Claude Cowork / Desktop  →  DuskFleet MCP server (stdio)  →  Orchestration  →  Claude Code CLI  →  local project
```

This document is the design for the first vertical slice plus the shape of what comes after.
It is meant to stay short and readable. Update it when the design changes.

---

## 1. Environment inspection (verified on 2026-09-30)

| Item | Value |
|---|---|
| OS | macOS (Darwin 25.6) |
| Node.js | v24.15.0 (`node:sqlite` built in, no native addon needed) |
| npm | 11.12.1 |
| Claude Code CLI | 2.1.285 at `~/.local/bin/claude` |
| MCP SDK | `@modelcontextprotocol/sdk` 1.31 |

### Claude CLI flags verified against `claude --help` (2.1.285)

These are the only flags the executor uses. Each one was checked against the installed CLI.

| Flag | Purpose in DuskFleet |
|---|---|
| `-p, --print` | Non-interactive execution |
| `--output-format stream-json` + `--verbose` | Line-delimited JSON events. `stream-json` refuses to run without `--verbose` (verified). |
| `--session-id <uuid>` | We generate the session id up front, so the Run knows it before the process starts |
| `--model <model>` | Only passed when explicitly selected |
| `--permission-mode <mode>` | `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` |
| `--permission-prompts none` | Unattended: anything that would prompt is denied instead of blocking |
| `--dangerously-skip-permissions` | Required in addition to `--permission-mode bypassPermissions`; gated by config |
| `--allowedTools` / `--disallowedTools` | Per-agent tool policy |
| `--append-system-prompt <text>` | Agent definition body becomes the appended system prompt |
| `--max-budget-usd <amount>` | Hard cost cap per run |
| `--effort <level>` | Optional per-agent effort |
| `--strict-mcp-config` | Optional: isolate the child from user-level MCP servers (default on, configurable) |
| `--setting-sources <list>` | Optional: restrict which settings files the child loads (`claude.setting_sources`) |
| `-r, --resume <id>` | Not used by the executor, but surfaced to the user as the "resume this run" command |

### Verified `stream-json` event shapes

Probed with `claude -p ... --output-format stream-json --verbose`:

- `{"type":"system","subtype":"init","cwd":…,"session_id":…,"model":…,"tools":[…],"permissionMode":…,"claude_code_version":…}`
- `{"type":"assistant","message":{"model":…,"usage":{…},"content":[{"type":"text"|"tool_use",…}]}}`
- `{"type":"user", …}` (tool results)
- `{"type":"result","subtype":"success"|…,"is_error":bool,"session_id":…,"result":string,"num_turns":n,"duration_ms":n,"duration_api_ms":n,"total_cost_usd":n,"usage":{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,…},"modelUsage":{…},"permission_denials":[…],"terminal_reason":string,"stop_reason":string}`

The `result` line is the authoritative source for cost, tokens, turns and termination reason.
`permission_denials` is our signal for "human intervention would have been required".

Subagent lines (verified 2026-10-12 on a run that delegated twice):

- `{"type":"system","subtype":"task_started","task_id":…,"tool_use_id":…,"description":…,"subagent_type":…,"prompt":…,"spawn_depth":n}`
- every message produced inside the subagent carries `"agent_id":<task_id>`, `"parent_tool_use_id":<Agent tool_use id>`, `"subagent_type"`, `"task_description"` and a `"timestamp"`; the main session has `"parent_tool_use_id":null`
- `{"type":"system","subtype":"task_progress"|"task_notification","task_id":…,"status":…,"summary":…,"usage":{"total_tokens":n,"tool_uses":n,"duration_ms":n}}`
- the parent then receives a normal `tool_result` for the Agent call: the hand-back, with the report as text blocks

The parser folds these into one `SubagentRecord` per invocation (`execution/types.ts`). The per-message
`usage.output_tokens` of nested assistant lines is a streaming snapshot and undercounts; `total_tokens`
from the task lines is the figure to use. One API response is streamed as several `assistant` lines
sharing `message.id`; usage is counted once per id.

---

## 2. Architecture

### Principles

- **Declarative config in files, runtime history in SQLite.** `config/` says what DuskFleet *should* do and is Git-friendly. `data/duskfleet.db` records what it *did*.
- **Execution is isolated.** Only `src/execution/` knows about the Claude CLI. Everything else talks to an `Executor` interface.
- **Process arguments, never shell strings.** Claude Code is spawned with `child_process.spawn(binary, argv, { cwd, shell: false })`. The project path is the process working directory. Nothing user-supplied is ever interpolated into a shell command.
- **Every run is recorded before it starts.** The exact argv, cwd, permission mode and session id are written to SQLite before `spawn`.
- **Async by default.** Runs take minutes. MCP tools return a `run_id` immediately; callers poll `get_run`. A tool can optionally wait a bounded number of seconds.
- **Small and understandable.** Four runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `yaml`, plus Node built-ins).

### Module layout (npm workspaces)

```
duskfleet/
├── PLAN.md, README.md, docs/*.md, package.json (workspaces), tsconfig.base.json
├── config/                      # declarative, version-controlled
│   ├── duskfleet.yaml          # global settings (paths, executor defaults, safety gates)
│   ├── agents/*.md              # agent definitions: YAML frontmatter + Markdown system prompt
│   └── projects.yaml            # optional named project registry
├── data/                        # runtime, git-ignored
│   ├── duskfleet.db            # SQLite
│   └── logs/<run_id>.jsonl      # raw stream-json from Claude Code, one file per run
├── packages/
│   ├── core/                    # @duskfleet/core — no MCP, no React
│   │   └── src/{config,storage,execution,orchestration,observability,evals,scheduler,util}
│   └── mcp/                     # @duskfleet/mcp — MCP server (stdio), CLI, tests
│       ├── src/{index.ts,cli.ts,bootstrap.ts,mcp/}
│       └── test/{fake-claude.js,*.test.js}
└── apps/
    └── web/                     # @duskfleet/web — Next.js 15 dashboard, read-only
        ├── app/{page.tsx,agents/page.tsx,runs/[id]/page.tsx}
        └── lib/data.ts          # server-only access to config + SQLite via @duskfleet/core
```

Dependency direction: `apps/web` → `core`; `packages/mcp` → `core`. Inside core: `orchestration` → `execution`, `storage`, `config`, `observability`.
`execution` never imports `storage`. `storage` never imports anything above it. `web` and `mcp` never import each other.

### Runtime shape

The MCP server is a single long-running Node process started by the MCP client (Claude Desktop / Cowork) over stdio.
Claude Code runs as child processes of that server. Logs go to **stderr** because stdout is the MCP transport.

The dashboard is a separate Next.js process reading the same SQLite file (WAL mode, concurrent reader). It is
read-only in the MVP: mutations that need the live child process (cancel) stay in the MCP server. A later
iteration can add a small local HTTP API to the MCP server for the dashboard to call.

---

## 3. Assumptions and things to verify

| # | Assumption | Status |
|---|---|---|
| A1 | `node:sqlite` is available without flags on Node 24 | Verified |
| A2 | The `claude` binary is authenticated for the user who runs the MCP server | Must be true; DuskFleet does not manage auth. Run `claude` once interactively. |
| A3 | GUI-launched MCP servers may have a minimal `PATH`. | Handled: `claude.binary` in config, `CLAUDE_BIN` env, then `PATH`, then `~/.local/bin/claude`. |
| A4 | Running Claude Code from inside another Claude Code session sets `CLAUDECODE=1` and nested sessions may refuse to start. | Handled: the executor strips `CLAUDECODE` / `CLAUDE_CODE_*` entrypoint variables from the child environment. |
| A5 | `permission_denials` in the result approximates "needed a human". | Heuristic. Good enough for MVP; refine with hook events later. |
| A6 | Context exhaustion is visible via `terminal_reason` / `subtype` / result text. | Heuristic: recorded raw plus a derived boolean. Exact values to be confirmed on real long runs. |
| A7 | `total_cost_usd` is reported for subscription (OAuth) users as well as API-key users. | Verified: a real run reported cost, tokens and `terminal_reason: "completed"`. |
| A8 | Killing the MCP server does not necessarily kill children on macOS. | Handled: the server tracks child PIDs and kills them on shutdown; orphaned `running` rows are marked `failed` on next start. |
| A9 | User-level hooks run inside child sessions. A `Stop` hook that needs a desktop/terminal (notifications via `terminal-notifier`/`osascript`) can block a headless run indefinitely. | Verified during development. Mitigation: `claude.setting_sources: [project, local]` skips `~/.claude/settings.json` for runs. |

---

### Verified 2026-10-08 (Claude Code 2.1.295)

- `--strict-mcp-config` → 0 MCP servers; without it a headless run gets the user's claude.ai connectors (Atlassian Rovo, Figma, Gmail, Drive, Docs) already authenticated, 140 MCP tools. Exposed as `inherit_mcp` per agent/project; no `--mcp-config` file needed for connectors.
- `--permission-prompts none` ignores user/project/local settings files, confines file tools to cwd (+ `--add-dir`), and refuses `bypassPermissions`.
- `plan` mode denies Bash, MCP and writes even when allow-listed. `dontAsk` + `--allowedTools` + `--disallowedTools Edit Write NotebookEdit` is the working read-only recipe.
- Denials are recorded per call (`denied_tools_json`, migration 2) and surfaced as `deniedTools` / `needsReview` in `list_runs`.

## 4. Minimal SQLite schema

```sql
CREATE TABLE runs (
  id                    TEXT PRIMARY KEY,           -- run id (uuid)
  agent_id              TEXT NOT NULL,
  project_path          TEXT NOT NULL,              -- resolved absolute path used as cwd
  project_id            TEXT,                       -- name from projects.yaml when used
  prompt                TEXT NOT NULL,
  model_requested       TEXT,                       -- only when explicitly selected
  model_used            TEXT,                       -- from system/init or result
  status                TEXT NOT NULL,              -- see §6
  created_at            TEXT NOT NULL,              -- ISO-8601
  started_at            TEXT,
  ended_at              TEXT,
  duration_ms           INTEGER,
  claude_session_id     TEXT,
  permission_mode       TEXT NOT NULL,
  command_json          TEXT NOT NULL,              -- {binary, argv, cwd} exactly as spawned
  exit_code             INTEGER,
  termination_reason    TEXT,                       -- terminal_reason / subtype from Claude
  error                 TEXT,
  result_text           TEXT,                       -- final assistant text
  num_turns             INTEGER,
  tool_calls            INTEGER,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd              REAL,
  permission_denials    INTEGER,
  human_intervention    INTEGER NOT NULL DEFAULT 0, -- boolean
  context_exhausted     INTEGER NOT NULL DEFAULT 0, -- boolean
  retries               INTEGER NOT NULL DEFAULT 0,
  log_path              TEXT,
  raw_result_json       TEXT                        -- full result line for later analysis
);

CREATE TABLE run_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(id),
  ts        TEXT NOT NULL,
  type      TEXT NOT NULL,       -- status_change | init | tool_use | error | note | subagent_start | subagent_end
  payload   TEXT,                -- JSON
  agent_id  TEXT                 -- subagent the event belongs to; NULL = main session (migration 5)
);

CREATE TABLE run_agents (         -- one row per subagent invocation (migration 5)
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL REFERENCES runs(id),
  agent_id           TEXT NOT NULL,       -- Claude Code task id
  parent_tool_use_id TEXT,                -- the Agent call that spawned it
  parent_agent_id    TEXT,                -- NULL = spawned by the main session
  subagent_type      TEXT NOT NULL,       -- .claude/agents/<name>.md or a builtin
  description        TEXT, prompt TEXT, result_text TEXT,
  status             TEXT NOT NULL,       -- running | completed | failed | interrupted
  model              TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
  tool_calls         INTEGER NOT NULL DEFAULT 0, tools_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  total_tokens       INTEGER,             -- from task_notification; the reliable figure
  definition_hash    TEXT,                -- sha256 prefix of the project agent file at start
  UNIQUE (run_id, agent_id)
);

CREATE TABLE evals (              -- foundations only; nothing writes here in the MVP
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  name       TEXT NOT NULL,       -- e.g. tests_passed, requirements_satisfied
  kind       TEXT NOT NULL,       -- deterministic | llm
  status     TEXT NOT NULL,       -- pass | fail | error | skipped
  score      REAL,
  details    TEXT,                -- JSON
  created_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

Raw per-run event logs live in `data/logs/<run_id>.jsonl`, not in SQLite, so the database stays small and queryable.

---

## 5. MCP tools for the first vertical slice

| Tool | Input | Output |
|---|---|---|
| `list_agents` | — | builtin agents from `config/agents/*.md` plus user agents from `user_agents_dir` (default `data/agents`), with `source` |
| `create_agent` / `update_agent` / `delete_agent` | agent spec fields | write/merge/remove `<user_agents_dir>/<id>.md`. Never touch `config/agents`; `bypassPermissions` not offered; a user agent overrides a builtin with the same id (added 2026-10-08) |
| `list_projects` | — | named projects from `config/projects.yaml` plus allowed roots |
| `run_agent` | `prompt`, `project_path` or `project_id`, optional `agent_id` (default from config), `model`, `wait_seconds` (0–300) | `run_id`, `status`, `claude_session_id`, and the full run when it finished within the wait |
| `get_run` | `run_id`, optional `include_output` | full Run record, including the `claude --resume <session>` command |
| `list_runs` | optional `status`, `agent_id`, `project_path`, `limit` | summaries |
| `cancel_run` | `run_id` | updated status |

Adding a tool later means adding one file in `src/mcp/tools/` and registering it in `src/mcp/server.ts`.

---

## 6. Run lifecycle

```
            create()            spawn ok                 result/exit
  ┌───────┐        ┌──────────┐          ┌─────────┐               ┌───────────┐
  │       │ ─────▶ │ pending  │ ───────▶ │ running │ ─────────────▶│ completed │
  └───────┘        └──────────┘          └─────────┘               └───────────┘
                        │                     │  │  │
                        │ spawn error         │  │  └── timeout ──▶ timed_out
                        ▼                     │  └───── cancel ───▶ cancelled
                     failed  ◀────────────────┘  is_error / non-zero exit / parse failure
```

- `pending` — Run row written with the full command. Nothing has executed yet.
- `running` — process spawned; `started_at` set; `claude_session_id` known (we chose it).
- `completed` — `result` line received with `is_error=false` and exit code 0.
- `failed` — spawn error, non-zero exit, `is_error=true`, or no result line.
- `cancelled` — `cancel_run` sent SIGTERM (then SIGKILL after a grace period).
- `timed_out` — the agent's `timeout_minutes` elapsed; process killed.

Terminal states are `completed | failed | cancelled | timed_out`. Transitions are enforced in `orchestration/run-state.ts` and every transition is appended to `run_events`.

Future: `scheduled` (before `pending`) once the scheduler exists.

---

## 7. MVP vs later

### In the MVP (this iteration)

- MCP server over stdio with the six tools above
- Agent definitions as Markdown + YAML frontmatter
- Project path validation (absolute, exists, is a directory, not `/` or `$HOME`, inside `allowed_project_roots` if set)
- Claude Code executor with structured capture: session id, model, timings, exit status, tokens, cost, turns, tool calls, permission denials, termination reason
- SQLite runs / run_events / evals tables
- Local CLI (`duskfleet run|runs|run-info|agents|projects|doctor`) for testing without an MCP client
- Per-run raw log files
- Next.js dashboard (`apps/web`): runs (live), agents with stats, run detail with timeline and command
- Tests: `packages/mcp/test/fake-claude.js` replays the verified event shapes so `npm test` exercises the executor, state machine, SQLite storage and the MCP server over stdio without network or cost

### Verified end to end (2026-09-30)

`duskfleet run --project <tmp project> --model haiku -- "Create hello.txt ..."` launched Claude Code 2.1.285 with the project as cwd, created the file, and recorded a `completed` run with session id, model `claude-haiku-4-5-20251001`, 2 turns, 1 tool call, token counts and cost in SQLite. The same flow was driven through the MCP server with the SDK client (`test/mcp-client.test.js`).

### Deliberately later

- **Scheduling**: implemented 2026-10-10 as in-process ticks over a `schedules` table (not YAML: schedules are created over MCP and carry runtime state). Cron parser in `scheduler/cron.ts`, engine in `scheduler/scheduler.ts`, create/update validation shared by MCP, CLI and dashboard in `scheduler/crud.ts`, lease in `storage/schedules.ts` so the MCP server and `duskfleet serve` never double-fire. Per-agent / per-project WIP guards live in `RunManager`.
- **Unattended scheduling** (2026-10-12): the lease holder is `<role>@host:pid` (`serve`, `mcp`, `cli`) so the dashboard and `doctor` can say who ticks. `duskfleet install-service` (`packages/mcp/src/service.ts`) registers `serve` as a per-user service: launchd LaunchAgent on macOS, systemd user unit on Linux, Task Scheduler logon task (XML import, no time limit, restart on failure) on Windows. Rejected alternative: the OS crontab, which would duplicate schedules outside the DB, lose the lease / busy / kill-switch semantics, and run with a minimal environment without the user's `claude` login; a one-minute cron tick also cannot own the long-lived child processes. The unit embeds machine paths and is never versioned; Windows is implemented but unverified. The dashboard's Schedules page can pause / resume, edit cron + time zone, delete and run now (server actions on core; run now is a `run_requested_at` stamp, migration 6, that the lease holder consumes on its next tick: the dashboard never spawns Claude), create stays on MCP. Lease priority (2026-10-12, same day): `serve` preempts any `mcp` / `cli` / role-less holder on its first tick (`acquireLease(..., preempt)`, one extra clause in the UPDATE); the displaced process's renewal fails and it stands by. Cause: a `dist/index.js` spawned by an MCP host before a rebuild kept the lease with code that ignored `run_requested_at`, so "Run now" never fired while the freshly installed service waited forever. Two `serve` holders stay first come, first served.
- **Subagent tracking**: implemented 2026-10-12. Every Agent call inside a run becomes a `run_agents` row (brief, report, tools, model, tokens, persona hash), exposed by `get_run` and `run-info`. Next: the tree on the dashboard run page, a per-project-agent page with history across runs, and a static preflight in `startRun` that compares every `.claude/agents/*.md` `tools:` list with what the run will mount (refuse `mcp__plugin_*`, servers missing from the allow-list) before paying for a run.
- **Evals**: table and types exist; no evaluators. Planned: deterministic evaluators (`tests_passed`, `build_passed`, `files_exist`) run as post-run hooks defined in `config/evals/*.yaml`; LLM evaluators as a second Claude Code run in read-only mode. With `run_agents` the unit an LLM eval judges can be a single subagent invocation (its brief vs its report), and metrics can aggregate by `subagent_type`.
- **Retries**, run queues and concurrency limits beyond a simple `max_concurrent_runs`.
- **Metrics / reporting tools** (`compare_models`, `cost_report`) once there is data worth querying.
- **Hook-based intervention detection** via `--include-hook-events`.
- **Git integration** (auto-branch per run, diff capture) — valuable for evals, not needed to prove the pipeline.
- **Second runtime: OpenAI Codex CLI** (assessed 2026-10-11 against `codex exec --help`, codex-cli 0.157.0; not started).
  `RunManager` only knows the `Executor` interface, so Codex is a second implementation next to
  `claude-code.ts`, with its own JSONL parser next to `stream-json.ts`. Storage, dashboard and MCP
  tools stay unchanged; `command.binary` on the run record already tells the two families apart.
  - Flag mapping: `codex exec --json` (JSONL events on stdout) ~ `--output-format stream-json`;
    `-C <dir>` = project cwd; `--add-dir` = `add_dirs`; `-m` = model; `--sandbox read-only` for
    read-only agents and `workspace-write` for editing agents (no approval prompts in either);
    `--ephemeral` (no session files on disk); `--output-last-message <file>` for a clean final
    result; `--skip-git-repo-check` (a scratch target may not be a Git repo). Re-verify every flag
    against `codex exec --help` before use, as for `claude`.
  - Gaps, no one-to-one equivalent: no per-tool `allowed_tools` / `disallowed_tools` (control is
    per sandbox; execpolicy `.rules` files are the closest thing); no `--agent <name>` and no
    `.claude/agents/*.md`, so `link` agents need a Codex-specific meaning (an `AGENTS.md` in the
    project); no system-prompt flag, so an `own` agent's body goes into the prompt or a temporary
    `AGENTS.md`; the result reports tokens but not a dollar cost.
  - Design: `runtime: claude | codex` in the agent frontmatter (default `claude`), `RunManager`
    picks the executor from a map keyed by runtime. `contextExhausted` stays structured-only.
  - First step when picked up: capture two or three real `codex exec --json` runs against
    a local scratch project and add them as fixtures to the test suite (a `fake-codex.js` beside
    `fake-claude.js`) before writing the executor.
  - Sequencing: after deterministic evals. Two runtimes pay off when evals can compare them on the
    same task; before that it is a second binary to maintain.
