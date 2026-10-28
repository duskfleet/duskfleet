# Configuration

Everything declarative lives in `config/` and is meant to be committed to Git. Machine-specific
values (your own projects, your own agents, the MCP registration) live in git-ignored files:
`data/projects.yaml`, `data/agents/`, `.mcp.json`.

## Where config and data live

The config directory (the one holding `duskfleet.yaml`, `agents/`, `projects.yaml`) is the first
of these that applies:

1. `DUSKFLEET_CONFIG`, a path to the directory.
2. A repo-local `config/`: the closest directory above the CLI (or the MCP server, or the
   dashboard's working directory) that contains `config/duskfleet.yaml`. A clone of this
   repository uses this one with no variable set.
3. The user-level directory, for an installed package (`npx duskfleet`) with no checkout above it:

| Platform | Config | Data |
|---|---|---|
| Linux, macOS | `$XDG_CONFIG_HOME/duskfleet` (default `~/.config/duskfleet`) | `$XDG_DATA_HOME/duskfleet` (default `~/.local/share/duskfleet`) |
| Windows (experimental) | `%APPDATA%\duskfleet` | `%LOCALAPPDATA%\duskfleet` |

A relative `XDG_*` value is ignored, as the XDG specification says. macOS uses the XDG paths
rather than `~/Library/Application Support`: Duskfleet is a terminal tool (like `~/.claude` or
`~/.config/gh`), the paths carry no space to quote in service units, shell commands and
`add_dirs`, and Linux and macOS share one set of paths in these docs.

The data directory (SQLite database, `logs/`, user agents, the private `projects.yaml`) is the
first of: `DUSKFLEET_DATA`; `data_dir` in `duskfleet.yaml` (relative to the config directory);
the user-level data directory when the config is the user-level one; otherwise `../data` next to
the config directory (a clone's `data/`). `duskfleet doctor` prints both directories, where each
came from (`configSource`, `dataSource`) and every config candidate (`configLookup`).

A user-level config directory starts with a starter `duskfleet.yaml` (no agent: Duskfleet ships
none), written by the onboarding command; it is never overwritten. Until it exists, every
command but `--help` / `--version` fails with `Config file not found` and the
`npx duskfleet init` hint.

### Moving a repo-local `data/` to the user-level directory

There is no automatic migration. With nothing running (stop `serve`, the service and any MCP
host), copy the directory, including the SQLite `-wal` / `-shm` files, then check:

```bash
mkdir -p ~/.local/share/duskfleet
cp -R /path/to/duskfleet/data/. ~/.local/share/duskfleet/
DUSKFLEET_DATA=~/.local/share/duskfleet npx duskfleet doctor    # dataDir points at the copy
```

An installed package with a user-level config finds the copy on its own. While you still run from
the clone, set `data_dir: ~/.local/share/duskfleet` in its `duskfleet.yaml` rather than relying on
`DUSKFLEET_DATA`: the service unit written by `install-service` carries `DUSKFLEET_CONFIG` when it
needs it, not `DUSKFLEET_DATA`. Re-run `install-service` afterwards so the service picks up the
new paths, and remove the old `data/` once runs and schedules show up as expected.

## `config/duskfleet.yaml`

```yaml
data_dir: ../data               # SQLite + logs (git-ignored); omitted = see "Where config and data live"
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
