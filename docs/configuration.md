# Configuration

Everything declarative lives in `config/` and is meant to be committed to Git. Machine-specific
values (your own projects, your own agents, the MCP registration) live in git-ignored files:
`data/projects.yaml`, `data/agents/`, `.mcp.json`.

## `config/duskfleet.yaml`

```yaml
data_dir: ../data               # SQLite + logs (git-ignored)
allowed_project_roots: []       # e.g. [~/Documents/Projects]; empty = any directory except / and ~
default_agent: null              # or an agent id; null = run_agent requires agent_id
max_concurrent_runs: 8
claude:
  binary: null                  # set to /Users/you/.local/bin/claude if PATH is minimal (GUI launch)
  strict_mcp_config: true       # child sessions ignore user-level MCP servers (faster, no hangs)
  setting_sources: null         # or [project, local] to skip ~/.claude/settings.json (user hooks) in runs
  allow_bypass_permissions: false
  default_timeout_minutes: 30
  default_max_budget_usd: 5
  env_passthrough: []           # variables every run (and command gate) gets beyond the default allow-list, e.g. [GH_TOKEN]
scheduler:
  enabled: true                 # kill switch, re-read every tick
  tick_seconds: 30
  default_time_zone: Europe/London
  noop_pattern: '/^\s*(nothing to do|no .* in ready)/i'   # final message of a run that found no work (idle-cost stats)
  auto_pause_after: 5           # pause a schedule after this many empty / needs-review runs in a row; 0 = never
  allow_command_gates: false    # schedule command gates (`sh -c`, outside Claude Code's allow-lists) are refused unless true
```

Config is re-read on every run and every `list_*` tool call: edits apply without restarting
anything.

The dashboard's [Settings page](dashboard.md) edits most of these keys in this same file
(comments kept; a value the loader refuses is rolled back), so a hand edit and a dashboard edit
are the same thing. There are no overrides stored elsewhere.

## Projects: `config/projects.yaml` (optional)

```yaml
projects:
  my-app:
    path: ~/Documents/Projects/my-app
    description: Main web app
```

Callers can then pass `project_id: my-app` instead of a path. Every path is validated at run time:
absolute, exists, is a directory, not `/` or your home directory, and inside
`allowed_project_roots` when that list is set.

Relative project paths resolve from the directory of the file they are in, never from the
shell's cwd. Keep your own projects (machine-specific absolute paths) in the **private**
registry `data/projects.yaml` (`user_projects_file`, git-ignored), same syntax; the versioned
`config/projects.yaml` only carries repo-relative examples. A private entry with the same id wins.

Per project you can also set:

- `inherit_mcp: true`: every run on the project sees the MCP servers of the user running
  Duskfleet (see [MCP servers inside runs](agents.md#mcp-servers-inside-runs)).
- `add_dirs: [...]`: extra directories the run may read and write (`--add-dir`). Runs are
  otherwise confined to the project directory.

Both apply to every run on that project, whatever the agent says.

## Concurrency

`max_concurrent_runs` caps processes overall; `max_concurrent_per_project` (default 1) keeps
two agents out of the same working copy; `max_concurrent_per_agent` (default 1) is the
agent's WIP limit, so a scheduler tick whose previous run is still going is refused with
`agent busy` rather than doubled. Refusals are errors, not a queue.

The two per-scope limits are defaults an agent may override in its frontmatter:
`max_concurrent: <n>` replaces `max_concurrent_per_agent` for that agent, and `isolated: true`
takes its runs out of `max_concurrent_per_project` (they neither count against it nor wait
for it). `max_concurrent_runs` always stays the hard cap. See
[Running an agent in parallel](agents.md#running-an-agent-in-parallel).

## Environment variables

| Variable | Purpose |
|---|---|
| `DUSKFLEET_CONFIG` | Directory containing `duskfleet.yaml` (default: the closest ancestor `config/` of the running package / cwd) |
| `CLAUDE_BIN` | Path to the Claude Code binary (overrides `claude.binary`). Read by Duskfleet only: it is not passed on to agent runs. |
| `DUSKFLEET_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

### What reaches a run

A run's Claude Code child, and a schedule's command gate, get an allow-list of Duskfleet's own
environment, not a copy of it. By default: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
`LC_*`, `TMPDIR`, `TERM`, `TZ`, `ANTHROPIC_*`, `CLAUDE_*`, `NODE_*`, `npm_config_*`, `XDG_*`, and
on Windows `SystemRoot`, `windir`, `ComSpec`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`,
`USERPROFILE`, `USERNAME`, `TEMP`, `TMP`. `CLAUDE_BIN` and the markers of a nested Claude Code
session (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_*`) never reach it. Anything
else (`GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*`, ...) is dropped.

To pass more, name it, as an exact name or `PREFIX_*`:

```yaml
claude:
  env_passthrough: [GH_TOKEN]   # every run and command gate
```

or per agent, in its frontmatter (`env_passthrough: [NPM_TOKEN]`, see
[agents](agents.md#frontmatter)). The two lists are merged. The usual one is `GH_TOKEN` for an
agent that runs `gh`. A command gate gets the global list plus its schedule agent's. See
[security](security.md#process-and-environment).
