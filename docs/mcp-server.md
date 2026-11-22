# MCP server

```bash
npm run mcp            # = node packages/mcp/dist/index.js
```

The server speaks MCP over stdio; logs go to stderr. Runs execute as child processes of the
server, so keep it alive while runs are in progress. Each run records the process that owns
it; a run still marked `running` (or `pending`, never spawned) whose owner is gone is closed as `failed` with an "orphaned"
error, at the next start of any Duskfleet process, or within a minute by the scheduler lease
holder while `scheduler.enabled` is true and some process holds the lease. Runs owned by
another live process are left alone: they count toward `max_concurrent_per_project` /
`max_concurrent_per_agent` here too, and `cancel_run` refuses them (cancel them from the
process that owns them, named in the error). The server also ticks the
[scheduler](schedules.md) while it is alive.

After `npm run build`, restart the host (Claude Desktop, or the Claude Code session) to load
the new code. Config under `config/` needs no restart.

## Register with an MCP host

```bash
duskfleet mcp register --target claude-desktop --dry-run   # print the diff, change nothing
duskfleet mcp register --target claude-desktop             # print the diff, ask, back up, write
duskfleet mcp register --target claude-code --dry-run      # print the claude mcp add command only
duskfleet mcp register --target claude-code --yes          # print it and run it without asking
duskfleet mcp register --target copilot --dry-run          # print the copilot mcp add command only
duskfleet mcp register --target codex                      # print the codex mcp add command, ask, run it
duskfleet mcp status                                       # each host's entry, what it runs, which database it opens
```

(From a checkout: `npm run cli -- mcp register ...`.) The command always shows the exact
change first, with the config and data directories the entry will use, and asks before
applying it; `--yes` skips the question, and outside a terminal (a script) it is required,
otherwise nothing is changed.

Any host can ask, any harness can run: the host is only where you talk to Duskfleet, the
agent runs on the harness its file names (`harness:`, [Harnesses](harnesses.md)).

| Host (`--target`) | Registered through | Can run agents on |
|---|---|---|
| Claude Code (`claude-code`) | `claude mcp add --scope user` | claude, copilot, codex |
| Claude Desktop (`claude-desktop`) | `claude_desktop_config.json` (diff, backup) | claude, copilot, codex |
| Copilot CLI (`copilot`) | `copilot mcp add` | claude, copilot, codex |
| Codex CLI (`codex`) | `codex mcp add` | claude, copilot, codex |

A harness is usable when its CLI is installed on this host (`doctor` lists them); a field the
harness cannot honour is refused by name when the agent is created (`create_agent` says which
harnesses this host has).

**One database for every host.** Registering several hosts is meant to drive one Duskfleet:
one config directory, one SQLite database, one dashboard. `mcp status` shows, under each
registered host, the data and config directories its entry resolves to (from the entry's
`DUSKFLEET_CONFIG` / `DUSKFLEET_DATA`, or where the server finds them by itself), and warns when
a host opens another data directory than this install (an entry registered from another
checkout or install, for example): what that host creates goes to a database the dashboard
does not show. `doctor` repeats the warning in one line. Remove that entry and register again
from this install.

- **Claude Desktop**: the `mcpServers.duskfleet` entry of `claude_desktop_config.json` is added
  or replaced; every other key and server is kept. The diff of that entry is printed, the file
  is copied to `claude_desktop_config.json.bak-<timestamp>` next to it, then written (as
  2-space JSON). If the file changed while the question was open (Claude Desktop or you editing
  it), the new content is rebuilt from the file as it is then, so that edit is kept. The write
  keeps the file's permissions (a `600` config stays `600`) and, when the config is a symlink
  (a dotfiles manager), replaces the file it points to, not the link. A file that
  is not valid JSON is refused and left as it is. Restart Claude
  Desktop afterwards. The config lives at:

  | Platform | Path |
  |---|---|
  | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
  | Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
  | Linux | `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json` (default `~/.config/Claude/...`) |

- **Claude Code**: `claude mcp add duskfleet --scope user -e CLAUDE_BIN=... -- <command>` is
  printed, then run (the name comes first: `-e` takes several values and would swallow it). When a user-scope `duskfleet` entry already exists (read from
  `~/.claude.json`) with the same command, arguments and environment nothing runs; when any of
  them differs (a missing or stale `CLAUDE_BIN` included) the CLI stops and asks you to
  `claude mcp remove duskfleet` first.

- **Copilot CLI** and **Codex CLI**: `copilot mcp add duskfleet --env KEY=VALUE ... -- <command>`
  (or `codex mcp add ...`) is printed, then run through the CLI found the same way as for runs
  (`COPILOT_BIN` / `CODEX_BIN`, `copilot.binary` / `codex.binary`, `PATH`). Duskfleet never edits
  their config files (`~/.copilot/mcp-config.json`, `~/.codex/config.toml` or `$CODEX_HOME`): the
  current entry is read from `copilot mcp list --json` / `codex mcp list --json`. Same command,
  arguments and environment = nothing runs; anything else stops with `copilot mcp remove
  duskfleet` (or `codex mcp remove duskfleet`) to run first. The entry also carries
  `COPILOT_BIN` / `CODEX_BIN` when that binary was found outside `PATH`. Start a new session of the
  CLI afterwards. Duskfleet's own Codex runs pass `--ignore-user-config`, so the server
  registered here is never loaded inside a run.

  **Managed Copilot accounts**: an organization can disable third-party MCP servers by policy.
  The registration then succeeds and the server is blocked when a session starts ("Third-party
  MCP servers are disabled by your organization's Copilot policy. Only built-in servers are
  available."). That is the organization's setting (an allow-listed MCP registry), not something
  Duskfleet can change or detect before a session starts; `mcp register` and `mcp status` say so.
  The Copilot host is **not verified on a live Copilot session by the maintainers** (their
  account is managed): the tests go through a fake CLI. Reports from an unmanaged account are welcome.

**The command registered** is `node` and the server's `dist/index.js`, both as absolute paths
of the install that ran `mcp register`, with `CLAUDE_BIN` (and `DUSKFLEET_CONFIG` when the
server would not find its config by itself). Absolute paths because GUI hosts start with a
minimal `PATH` and Claude Desktop does not expand `~`; the cost is that the entry points at
this install, so moving or removing it means registering again. The alternative,
`npx -y -p duskfleet@<version> duskfleet-mcp`, is used only when the CLI itself runs from
npx's temporary cache (`npx duskfleet mcp register`), because that cache is evicted by npm at
any time: it is pinned to the installed version and called through npx's absolute path next
to `node`, but needs the network on the host's first start. The preview names the form used.

### By hand: Claude Desktop / Claude Cowork

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "duskfleet": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/duskfleet/packages/mcp/dist/index.js"],
      "env": {
        "CLAUDE_BIN": "/Users/you/.local/bin/claude"
      }
    }
  }
}
```

Use absolute paths for `node` (`which node`) and set `CLAUDE_BIN`: GUI apps start with a minimal
`PATH`, and Claude Desktop spawns the server without a shell, so `~` is never expanded (the
server then fails with "No executable file at ~/..."). Restart Claude Desktop and the
`duskfleet` tools appear. The dashboard's MCP page prints this snippet with your real paths.

### By hand: Claude Code

```bash
claude mcp add --scope user duskfleet -- node /absolute/path/to/duskfleet/packages/mcp/dist/index.js
```

Or copy `.mcp.json.example` to `.mcp.json` in this repo (git-ignored, machine-specific) and
fill in the absolute paths. The dashboard's **MCP** page prints both snippets with your paths.

Child runs never see the caller's MCP servers (`--strict-mcp-config`), so Duskfleet cannot
recurse into itself.

## Tools

| Tool | What it does |
|---|---|
| `list_agents` | Builtin (`config/agents`) and user (`user_agents_dir`) agents with their `source` and `kind`, grouped in `byProject` |
| `create_agent` | Write a user agent. **`kind` is required**: `own` (new persona, `system_prompt` required) or `link` (reuse an agent from a project folder: `claude_agent` + `project_path` or `project`, target verified; a new folder is registered in `data/projects.yaml`). Then `id`, optional `name`, `description`, `model`, `permission_mode`, `allowed_tools`, `disallowed_tools`, `effort`, `timeout_minutes`, `max_budget_usd`, `wrap_up_reserve_usd` (see [budget reserve](agents.md#budget-reserve-and-wrap-up-pass)), `on_failure`, `resume_budget_usd` (see [resume once](agents.md#resume-once-on-failure)), `system_prompt`, `inherit_mcp`, `add_dirs`, `claude_agent`, `project`. `overwrite: true` replaces a user agent or overrides a builtin. `bypassPermissions` is not offered. |
| `list_project_agents` | Agents a project defines in `.claude/agents/*.md` (name, description, tools, model), to reuse via `claude_agent` |
| `update_agent` | Merge fields into a user agent; `clear: [...]` removes optional fields. Pass `kind` to convert: `link` (with `claude_agent`) or `own` (with a `system_prompt`); `clear: ["claude_agent"]` unlinks and therefore needs a prompt. Builtins are read-only (override them instead). |
| `delete_agent` | Remove a user agent file; the builtin with the same id, if any, takes over again |
| `list_projects` | Named projects, allowed roots, executor info |
| `list_schedules` | Schedules with next/last firing, outcome of the last tick (`started` \| `resumed` \| `deferred` \| `skipped_busy` \| `skipped_daily_cap` \| `skipped_budget` \| `skipped_quota` \| `skipped_gate` \| `skipped_disabled` \| `auto_paused` \| `error`), `lastRun` (how the run it last started ended: `status`, `needsReview`, `reviewReasons`, `terminationReason`, `costUsd`), `effectiveOnFailure` and `willResumeRunId` (the run the next fire resumes, or null), `idle7d` (last 7 days: `ticks`, `fires`, `runs`, `noopRuns`, `noopCostUsd`, `costUsd`, `gateChecks`, `gateSkips`, `gateCostUsd`; see [idle cost](schedules.md#idle-cost)), `triggerKind` and scheduler status (kill switch, lease holder, `pause`: the [`pause_scheduler`](schedules.md#pausing-the-whole-scheduler) pause in force or null) |
| `create_schedule` | `name`, `agent_id`, `prompt`, `cron`, optional `time_zone`, `project_id`, `model`, `enabled`, `on_failure` (`resume_once` \| `none`, omit to inherit the agent's), `resume_budget_usd` (see [resume once](schedules.md#resume-once-on-failure)), `continue` (default false: every fire continues the session of the last ended run, see [continue the session](schedules.md#continue-the-session-across-fires)), `title` (stamped on every run it fires, see [run titles](schedules.md#run-titles)), `noop_pattern` (see [idle cost](schedules.md#idle-cost)), `gate` (`command` + `timeout_seconds`, refused unless `scheduler.allow_command_gates: true`, or `agent` with `agent_id`, `prompt`, `budget_usd`, `model`, `marker`; see [gates](schedules.md#gates-skip-cheaply-when-there-is-no-work)), `concurrency_policy` (`skip_if_active`), `catch_up_policy` (`skip_missed`), `trigger_kind` (`cron`; see [policies](schedules.md#policies)). [One schedule per agent](schedules.md#one-schedule-per-agent): an agent that already has one fails with `agent "<id>" already has the schedule "<name>" (<schedule id>); one schedule per agent, edit it or delete it first` |
| `update_schedule` | Merge fields (the policies and `trigger_kind` too); `enabled: false` pauses, `true` resumes from now; `title: ""` removes the title; `clear_model`, `clear_on_failure`, `clear_noop_pattern`, `clear_gate` remove the overrides; changing `agent_id` to an agent that already has a schedule fails with the same error as `create_schedule` |
| `delete_schedule` | Remove a schedule |
| `run_schedule_now` | Fire a schedule immediately, same busy and gate rules as a tick; `skip_gate: true` bypasses the gate |
| `pause_scheduler` | Pause every schedule for `minutes` (1 to 10080), optional `reason`; stored in the database, ends on its own; `minutes: 0` lifts it. See [pausing the whole scheduler](schedules.md#pausing-the-whole-scheduler) |
| `list_budgets` | Monthly budgets with this UTC month's `spentUsd`, the runs of unknown cost (`unpricedRuns`, `runningRuns`) and their `standInUsd`, `countedUsd`, `percent` and `state` (`ok` \| `warn` \| `over`); see [monthly budgets](agents.md#monthly-budgets) |
| `set_budget` | `scope` (`global` \| `agent` \| `project`), `scope_id` (agent or project id; omit for global), `amount_usd`, optional `warn_percent` (default 80), `hard_stop` (default true), `unpriced_policy` (`count`, default: runs of unknown cost count at a stand-in, [fail closed](agents.md#unknown-costs-fail-closed); `allow`: they do not). Creates the scope's budget or replaces it |
| `delete_budget` | Remove a budget; schedules it paused stay paused |
| `run_agent` | Start a run. `prompt` + (`project_path` \| `project_id`), optional `agent_id`, `model`, `title`, `wait_seconds` (≤300), `resume_run_id`. Returns the run immediately unless waiting. `title` says what the run is for (`fix #381`, at most 120 characters, trimmed, empty = none); every reader lists the run under its `label`: the title, else the first line of the prompt. `resume_run_id` sends the prompt into the Claude session of that ended run (agent and project default to its own). It is refused for a running, cancelled or context-exhausted run. When the agent, the project path or the agent definition (`agentHash`) differ, or Claude Code no longer has the session, the run starts a fresh session and a `note` event says why. The new run carries `continuedFromRunId`; it is not a retry (`retries` stays 0). See [continue the session](schedules.md#continue-the-session-across-fires). |
| `get_run` | Full run record incl. `title` and `label`, `claudeSessionId`, `resumeCommand`, tokens, cost, status, `phases` (the main pass and, after a budget exhaustion, the wrap-up pass: outcome, budget, cost, turns; see [budget reserve](agents.md#budget-reserve-and-wrap-up-pass)) and `subagents` (one per Agent call: `type`, `brief`, `report`, `toolCalls`, `durationMs`, tools, model, tokens; these names replace the earlier `subagentType`, `prompt` and `resultText`, which are no longer sent, and the CLI `run-info` uses the same set; older rows are backfilled from the run log by `duskfleet repair-subagents`; see [agents](agents.md#subagents-inside-runs)). `resumedFromRunId` / `resumedByRunId` link a run and its retry ([resume once](schedules.md#resume-once-on-failure)); `continuedFromRunId` / `continuedByRunIds` link a run and the runs that continued its session (`resume_run_id`, a schedule's `continue`). `artifacts` lists what the run produced, `[{kind, value, source}]`: today `kind: pr` with the PR URL, `source` `tool_result` or `result_text` ([what gets recorded](how-it-works.md#what-gets-recorded)); branches and commits are in `diff`. For a link, `projectAgentHash` is the hash of its project agent file at start, and `projectAgentChange` (`previousRunId`, `previousHash`, `hash`, `changed`, or null) compares it with the schedule's previous run ([reusing agents](agents.md#reusing-agents-a-project-already-defines)). `include_output: true` adds the final message, untruncated briefs and reports, and the event timeline. |
| `list_runs` | Recent runs with filters (`status`, `kind` (`run` \| `gate`), `agent_id`, `project_path`, `limit`); per run `title` and `label` (the title, else the first prompt line), `needsReview` with `reviewReasons` (budget exhausted, timed out, orphaned, non-zero exit, failed, permission denied, context exhausted, MCP missing; see [dashboard](dashboard.md#needs-review)), `terminationReason`, `errorCode` / `errorFamily` / `errorDetail` (why it failed, e.g. `auth_required`, `provider_quota` with `retryNotBefore`; see [what a run records](cli.md#what-a-run-records)), `wrapUp` (outcome and cost of the wrap-up pass, or null), `resumedFromRunId` and `resumedByRunId` (linked retry) |
| `cancel_run` | SIGTERM (then SIGKILL) the run's process; recorded as `cancelled` |

Outcomes of a schedule tick (`lastOutcome` in `list_schedules`; details in [schedules](schedules.md#policies)):

| Outcome | Meaning |
|---|---|
| `started` | the tick started a run |
| `resumed` | started as a resume of the previous run ([`on_failure: resume_once`](schedules.md#resume-once-on-failure)); counts as a fire |
| `deferred` | the agent or the project was busy; the tick waits as the schedule's one [deferred fire](schedules.md#busy-ticks-one-deferred-fire), retried every tick until the next occurrence |
| `skipped_busy` | the agent or the project already had a run and the trigger is lost (a deferred fire that reached the next occurrence, a manual fire, or `scheduler.defer_busy: false`); never queued |
| `skipped_daily_cap` | the agent (or its gate agent) reached `max_daily_runs` / `max_daily_cost_usd` for the UTC day |
| `skipped_budget` | a hard-stop monthly budget covering the run (global, agent or project) is spent; the schedules of that scope were paused |
| `skipped_quota` | the last run on this host hit the account's usage limit (`provider_quota`) and its reset time is still ahead, with no completed run on this host since; the next tick after the reset fires as usual |
| `skipped_gate` | the schedule's [gate](schedules.md#gates-skip-cheaply-when-there-is-no-work) said there is no work; the reason is the firing's error text |
| `skipped_disabled` | the schedule was paused when its tick came |
| `auto_paused` | its last `scheduler.auto_pause_after` runs were all empty or needs review: [paused](schedules.md#auto-pause) instead of fired |
| `error` | the fire failed (spawn, gate or config error); the message is the firing's error text |

`create_agent` and `update_agent` validate the spec before writing and roll the file back if
it does not load. An agent file edited by hand that does not load is skipped, not fatal:
`list_agents` reports it under `skippedAgents` (id, path, error) and its id is unavailable until
the file is fixed ([Agents](agents.md#a-file-that-does-not-load)). They
also refuse a spec that would be unfit for a public repo: a home directory path
(`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, `/Volumes/<name>`, or this machine's home
directory) or a secret-looking value (API keys, GitHub / Slack / AWS tokens, private keys,
`password: ...`-style assignments) in any field. `add_dirs` entries inside your home directory
are stored as `~/...` instead; placeholders such as `/Users/<you>` are fine.

## A typical conversation

From Claude Desktop or Claude Code:

> "Create a duskfleet agent `test-fixer` using haiku that may run `npm test` and never edits tests."
> → `create_agent` writes `data/agents/test-fixer.md`, usable immediately

> "Run the my-coder agent on ~/Projects/my-app: add input validation to the signup form."
> → `run_agent` returns `run_id` + `claudeSessionId`
> "How is it going?" → `get_run`
> "Show me what it said" → `get_run` with `include_output`
> Open the session yourself: `claude --resume <claudeSessionId>` inside the project.
