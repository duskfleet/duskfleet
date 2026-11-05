# CLI

The CLI uses the same orchestration code as the MCP server and is the quickest way to test.
The commands below are written for the npm package: `npx duskfleet <command>`, or
`duskfleet <command>` after a global install (`npm i -g duskfleet`). In a clone of this
repository (after `npm run build`) the same command is `npm run cli -- <command>`, shorthand for
`node packages/mcp/dist/cli.js <command>`.

```bash
npx duskfleet init                                       # guided setup; see "init" below
npx duskfleet init --yes [--mcp claude-code|claude-desktop]   # the same without prompts (scripts, CI)
npx duskfleet doctor                                     # Claude binary, version, config and data paths
npx duskfleet doctor --probe                             # plus one real hello run on haiku (costs cents)
npx duskfleet run --project ~/Documents/Projects/my-app -- "Add a README section describing the build"
npx duskfleet run --project my-app --agent my-reviewer --model sonnet -- "Review src/ for obvious bugs"   # registered id or path (--project-id is the explicit form)
npx duskfleet run --no-wait --project /path -- "..."     # return immediately (see the note below)
npx duskfleet run --project my-app --title "fix #381" -- "..."   # list the run under a title instead of the first prompt line (max 120 chars)
npx duskfleet run --project . --agent fixer -- "..."     # relative path: resolved from the shell's directory
npx duskfleet run --first [--project /path]              # the guided first run of init again (haiku, costs cents)
npx duskfleet runs --status completed --limit 10
npx duskfleet run-info <run_id> --events   # includes subagents; --events adds the timeline
npx duskfleet repair-subagents             # backfill subagent rows of finished runs from their logs
npx duskfleet agents                                     # empty list + a hint to agents create on a fresh install
npx duskfleet agents create fixer --model haiku -- "You fix the failing test in this project. ..."   # see below
npx duskfleet projects
npx duskfleet schedules
npx duskfleet schedules run-now "pr review"              # schedule id or name; the lease holder fires it on its next tick
npx duskfleet budgets                                    # monthly budgets with this month's spend and state
npx duskfleet budgets set project my-app --amount 50 [--warn 80] [--no-hard-stop]   # or: global | agent <id>
npx duskfleet budgets delete <budget id>
npx duskfleet dashboard [--port 4777] [--no-open] [--no-install]   # install @duskfleet/web on demand, start it (see dashboard.md)
npx duskfleet serve                                      # long-running scheduler process
duskfleet install-service [--print] [--no-keep-awake]    # global install only: register `serve` with launchd / systemd --user / Task Scheduler
duskfleet uninstall-service
npx duskfleet mcp register --target claude-desktop --dry-run   # or claude-code; preview, then --yes to apply (see mcp-server.md)
npx duskfleet mcp status                                 # which Claude hosts have a duskfleet entry; no config needed
npx duskfleet tools                                      # the MCP tool catalogue
npx duskfleet --help                                     # the usage (also -h); no config needed
npx duskfleet run --help                                 # one command's usage, options, example and doc link (any command)
npx duskfleet --version                                  # the package version (also -v); duskfleet-mcp --version too
```

`run --project` takes a registered project id or a path. A relative path (`.`, `../app`,
`./scratch`, or a bare name that is a directory where you are and not a registered id) is resolved
from the shell's directory, and the run records the absolute path; `~` is expanded. Only the CLI
does this: the MCP tools (`run_agent`'s `project_path`) and schedules have no meaningful working
directory and keep requiring an absolute path or a registered id.

`install-service` refuses to run from npx's temporary cache (npm can evict it, and the service
would point at a file that is gone): install the package globally first, `npm i -g duskfleet`,
then `duskfleet install-service`. In a clone, `npm run cli -- install-service` registers the
clone's build ([Schedules](schedules.md#who-ticks)).

On macOS `install-service` keeps the Mac awake by default (`--keep-awake`): the launchd unit runs
`serve` under `caffeinate -i -s`, which blocks idle sleep, and system sleep while on AC power
only (on battery the Mac may still sleep). `--no-keep-awake` renders the unit without
`caffeinate`. On Linux and Windows the flag changes nothing; `install-service` prints how to
disable sleep there. `doctor` reports `scheduler.keepAwake` on macOS.

`duskfleet` with no arguments prints the usage on stderr and exits 2; `--help` prints it on
stdout and exits 0. Both end with `First time here? Run: npx duskfleet init`.

Every command answers `--help` (or `-h`) with its own usage: one block with the options, an
example and the link to its doc page, on stdout with exit 0, with or without a config
(`duskfleet run --help`, `duskfleet agents create --help`). A `--help` after `--` is part of the
prompt, not a flag. A wrong invocation is named before any config is loaded, on stderr with exit 2:
an unknown command prints `unknown command: <name>` and the list of commands; a missing argument
prints what is missing (`error: run needs a prompt after --: ...`, `error: run-info needs a run id`)
followed by that command's usage.

Only commands that need the config report a missing one (`init`, `tools`, `mcp status`,
`uninstall-service` and every `--help` work without). That error ends with the same init hint
(no config means no `duskfleet.yaml` in the directory the lookup picked:
`DUSKFLEET_CONFIG`, a `config/` above the CLI, else the user-level directory; see
[where config and data live](configuration.md#where-config-and-data-live)). `--version` prints the version of the installed
`duskfleet` package and needs neither a config nor Node 24.

Logs go to stderr, so stdout stays the command's JSON. A one-shot command logs warnings and
errors only; `--verbose`, anywhere before a `--`, brings the info lines back (config loaded,
executor ready, `storage: applied N migrations (M → N)` after an upgrade). `serve` and the MCP
server keep info: their log is the record. `DUSKFLEET_LOG_LEVEL=debug|info|warn|error` overrides
both defaults and `--verbose`
([environment variables](configuration.md#environment-variables)).

## init

`init` prepares a first configuration. Each step prints its result; a config that cannot be
written or loaded stops with the fix and exit 1:

1. **Node**: the version (Node 24+ is checked before any command runs).
2. **Claude Code**: the binary (same lookup as runs: `CLAUDE_BIN`, `claude.binary`, `PATH`,
   `~/.local/bin/claude`), its version, and the login from `claude auth status --json`. Not
   installed, not starting or not logged in does **not** stop `init`: the problem is printed
   here, the config is written anyway, the fix is repeated after the summary (`Claude Code is not
   logged in: run claude auth login, then check it with: duskfleet doctor --probe`) and the exit
   code is 0. Before the login, `doctor`, `agents`, `projects`, `runs`, `schedules`, `budgets`,
   `agents create` and the dashboard work; `run`, `serve` and scheduled runs fail with
   `auth_required` and the same fix (`errorCode`, [what a run records](#what-a-run-records)).
3. **Config and data**: creates the user-level config directory with a starter `duskfleet.yaml`
   and the data directory ([where config and data live](configuration.md#where-config-and-data-live)).
   A config that already exists (user-level, a checkout's `config/`, or `DUSKFLEET_CONFIG`) is
   reported and left untouched, so running `init` twice is safe. `DUSKFLEET_CONFIG` pointing at
   a directory without `duskfleet.yaml` is an error: `init` writes only the user-level directory.
4. **MCP registration** (optional): on a terminal it asks `Register the MCP server in Claude Code
   / Claude Desktop / skip?` and then does what `mcp register --target ... --yes` does (preview,
   backup of an existing file, write; see [MCP server](mcp-server.md)).
   Then, on a terminal only, it offers the [guided first run](#guided-first-run) (a real run
   on haiku that costs cents; the answer defaults to no).
5. What was created, where, and the next commands: `doctor`, `agents create`, `run`. Duskfleet
   ships no agent; the only one `init` can create is `first-run`, and only when you accept the
   guided first run.

`init --yes` asks nothing: steps 1-3 and the summary, step 4 only with `--mcp claude-code` or
`--mcp claude-desktop`; without `--mcp` it never writes a Claude config file. It too succeeds
without a Claude login, so a script can prepare a machine before anyone logs in; a config that
cannot be written or loaded, or a failed `--mcp` registration, exits non-zero. On something that is not a terminal (a script) without `--yes`, step 4 is
skipped.

## Guided first run

The last, optional step of an interactive `init` (never under `--yes`, and skipped with one line
when step 2 found Claude Code missing or logged out), and `run --first` to repeat it at any time
(same code). **It costs real money**: one run on haiku, usually a few cents, stated before you
answer:

```text
Try a first run on a project of yours? It creates a read-only "first-run" agent, runs it with haiku and costs cents. [y/N]
```

On `y` it asks for the absolute path of a project directory (`run --first --project <path>`
skips that question), then:

1. Checks the path like every run does: absolute, an existing directory, not `/` or your home,
   and inside `allowed_project_roots` when that list is set
   ([configuration](configuration.md)). A path outside it is refused with the file to edit;
   nothing is created.
2. Registers the directory in the private project registry (`data/projects.yaml`), unless it
   is already a project (also when registered through a symlink).
3. Creates the agent `first-run` through the same path as `agents create` (own, `model: haiku`,
   `permission_mode: dontAsk`, `allowed_tools: [Read, Grep, Glob]`, `disallowed_tools: [Edit,
   Write, NotebookEdit]`, budget $0.25, 5 minutes; system prompt "You describe projects. You
   never change files."). When `first-run` already exists it is used only if it keeps the
   step's promise: `permission_mode: dontAsk`, Edit, Write and NotebookEdit disallowed, no
   write, Bash or MCP tool allowed, `inherit_mcp` off, a budget of at most $0.25, and no binding
   to another project. Otherwise the step stops before registering anything and names what
   to change.
4. Runs it with `--model haiku` and the prompt `Describe this project in three sentences. Do not
   change any file.`, waits, and prints the status, the duration, the tokens, the cost (or API
   value on a subscription), what the agent said, and `duskfleet run-info <run id>` /
   `duskfleet dashboard` to see more. A run that needs review gets one line saying why, with a
   link to [the dashboard page](dashboard.md). When the run is refused before it starts (agent
   or project busy, a daily cap, a spent monthly budget), the step prints the reason, runs
   nothing and goes on to step 5.
5. When step 3 created the agent, asks `Keep the first-run agent? [Y/n]`. `n` deletes
   `data/agents/first-run.md` (the same rule as `delete_agent`: user files only); the run keeps
   its agent id either way. An agent that existed before is never offered for deletion.

`run --first` exits 0 when the run completed, 1 when the path or the run was refused or the run did not
complete. It takes no `--agent`, `--model` or prompt: those are fixed.

## First run

Duskfleet ships no starter agent and `default_agent` is `null`, so a run needs `--agent`. The
README Quick start creates one, then runs it:

```bash
npx duskfleet init
npx duskfleet doctor
npx duskfleet agents create fixer --model haiku -- "You fix the failing test in this project. Run the tests, read the failure, change the minimum code, run them again. No git, no installs."
npx duskfleet run --project /abs/path/to/scratch-project --agent fixer -- "Fix the failing test"
```

A run with no agent, when none exists, fails with
`Known agents: (none: no agent file in <config>/agents or <user agents dir>; create one with "agents create <id>")`.

## What run prints

On stderr, the run id and its log as it starts. When the run did not end clean (failed, timed
out, cancelled, or completed but [needs review](dashboard.md#needs-review)), a short block follows before
anything else: the status with its review reasons, the cause in one line, the fix when there is
one, and where to look next. A run against a Claude that is not logged in:

```text
run 7f3c9a2e-... started (session 0b1d...)
log: <data>/logs/7f3c9a2e-....jsonl
run 7f3c9a2e-... failed (non-zero exit code)
cause: Claude is not logged in: Not logged in · Please run /login
fix: Claude Code is not authenticated: run "claude" in a terminal and log in (or check ANTHROPIC_API_KEY)
more: duskfleet run-info 7f3c9a2e-..., or the run's page in the dashboard; full record: run --json
```

The fix lines come from one table in core (`FAILURE_FIXES` per error code, `REVIEW_REASON_FIXES`
per review reason, plus a `claude` binary that was not found), the same one `doctor --probe`
uses for its advice. A permission denial names the denied tools.

On stdout, the run record as JSON for scripts (exit 0 for `completed` or, with `--no-wait`,
`running`; 1 otherwise). It leaves out `command.argv` (the full spawned command line, system
prompt included) and `rawResultJson`; `run --json` prints the full record, the same as
`run-info <run_id>`. `title` is what `--title` gave (null without it); `runs` and `run-info` also
print `label`, the title or else the first prompt line, the same label the MCP tools return.

## agents create

`agents create <id> [flags] -- "<system prompt>"` writes an **own** agent (the prompt is its
persona) to `user_agents_dir` (`agents/<id>.md` in the data directory; `data/agents/<id>.md` in a
clone), the same file and the same checks as the
MCP tool `create_agent`: the spec is validated before anything is written, home directory paths
and secret-looking values are refused in every field, and the file is removed again if the
config no longer loads. An existing id is refused unless `--force` is given. For a **link**
agent use `create_agent` over MCP ([Agents](agents.md)).

| Flag | Frontmatter field | Default when omitted |
|---|---|---|
| `--model <m>` | `model` | none: the Claude Code default, which can be the most expensive model |
| `--budget <usd>` | `max_budget_usd` | `0.5` |
| `--permission-mode <mode>` | `permission_mode` | `dontAsk` (`bypassPermissions` is refused, as in `create_agent`) |
| `--allowed-tools <a,b>` | `allowed_tools` | `Read`, `Grep`, `Glob`, `Edit`, `Write` and `Bash(...)` for `npm test`, `npm run test`, `npx vitest`, `npx jest`, `pytest`, `python -m pytest`, `cargo test`, `go test`, `make test` |
| `--disallowed-tools <a,b>` | `disallowed_tools` | none |
| `--timeout <minutes>` | `timeout_minutes` | `10` |
| `--description <text>` | `description` | empty |
| `--prompt-file <file>` | body (system prompt) | instead of the text after `--` |
| `--force` | | overwrite an agent with the same id (a builtin id becomes a user override) |

It prints `{ created, overrode, agent }` as JSON and the next command on stderr.

## doctor, logs and diffs

`doctor` prints where the config and data come from: `configDir` with `configSource` (`env` for
`DUSKFLEET_CONFIG`, `repo` for a `config/` found walking up from the CLI, `user` for the
user-level directory), `configLookup` (every candidate in precedence order, `null` when it does
not apply), and `dataDir` with `dataSource` (`env` for `DUSKFLEET_DATA`, `config` for `data_dir`
or the `../data` next to a repo config, `user` for the user-level data directory). The rules are
in [Configuration](configuration.md#where-config-and-data-live).

`doctor` also prints the effective `path` used to find `claude` and passed to runs; `pathDefaulted`
is true on macOS when the inherited `PATH` was missing or minimal (a GUI-launched host) and the usual
install directories were put in front ([Troubleshooting](troubleshooting.md)).

`doctor` also reports the scheduler: whether something is ticking, which kind of process holds
the lease (`serve`, `mcp`, `cli`) and whether the service is installed and running. See
[Schedules](schedules.md#who-ticks) for the service.

Like every CLI command, `doctor` starts with the orphan sweep: `running` rows, and `pending`
rows never spawned, whose owning process on this host is gone are marked failed as orphaned.
`orphans.recovered` lists the rows this sweep failed (`id`, `agentId`, `was`: `running` or
`pending`, `owner`, `createdAt`), so rows a previous build left stuck show up once; an empty list
means nothing was stuck ([Troubleshooting](troubleshooting.md#runs)).

> [!NOTE]
> On Windows the CLI and `install-service` (Task Scheduler) are **experimental**: implemented,
> not run by the maintainers ([platform support](../README.md#platform-support)). The service
> logs to `data/logs/serve.log` and keeps its task XML under `%LOCALAPPDATA%\Duskfleet`; the
> [Windows test plan](windows-test-plan.md) lists what to check.

`doctor --probe` adds a live check that `claude --version` cannot do: one minimal real run
(`--model haiku`, a few cents at most, capped by `--max-budget-usd 0.05`; the command says so on
stderr before spending). It runs in an empty temporary directory with the same unattended
envelope as every run (`setting_sources`, strict MCP, no permission prompts, no tools allowed)
and a timeout of `claude.default_timeout_minutes`, at most 2 minutes. It records no run. The
`probe` field reports the outcome, cost and an `advice` line: not logged in (expired auth), no
result before the timeout (a hook or prompt blocking the headless child), or a process that kept
running after its result (a user-level Stop hook). When `claude --version` already failed the
probe is not attempted (outcome `skipped`, nothing spent); a local error before the run (for
example no writable temp directory) gives outcome `error`. `doctor` exits 1 when the probe fails. Ctrl-C (or SIGTERM) during the
probe cancels the run, removes its temporary directory and exits 130 without a report.

Each run writes a raw event log to `data/logs/<run_id>.jsonl` and a structured row to SQLite.
In a git checkout it also writes the patch of what it changed to `data/logs/<run_id>.diff`;
`run-info` shows the summary as `diff` (base commit, files with lines added / deleted), the
same field as `get_run`, and the PRs, branches and commits the run produced as `artifacts`
([how it works](how-it-works.md#what-gets-recorded)).

## Firing an agent from a script or a git hook

`run --no-wait` prints the run id and exits, but the run's stream-json is read by the process
that spawned it: once the CLI exits nobody records the result and the row stays `running`. Use it
only to kick a run from an interactive shell you will inspect afterwards.

For a hook or any script that must return at once, trigger a schedule instead:

```bash
duskfleet schedules run-now "pr review"
```

This only stamps `run_requested_at` on the schedule row (the same thing the dashboard's **Run
now** does); the process holding the scheduler lease, normally the
[service](schedules.md#who-ticks), fires it on its next tick (≤ `tick_seconds`), even when the
schedule is paused, with the usual busy rules. Nothing is spawned by the hook itself. A
`pre-push` hook that asks for a PR review after every push looks like this (`.git/hooks/pre-push`,
executable; `.git/` is never versioned):

```sh
#!/bin/sh
# Ask Duskfleet to review the PR of the branch being pushed. The run starts on the
# service's next tick, i.e. after this push has landed. Pushes of main are skipped.
want=
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  case "$remote_ref" in
    refs/heads/main) ;;
    *) want=1 ;;
  esac
done
[ -n "$want" ] || exit 0
root="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
node "$root/packages/mcp/dist/cli.js" schedules run-now "pr review" >/dev/null 2>&1 || true
exit 0
```

`--git-common-dir` resolves the main checkout from a worktree too; `|| true` keeps a stopped
service or a missing build from blocking the push. The schedule itself is an ordinary paused or
enabled schedule whose agent reviews "the oldest open PR without a verdict", so a push of a
branch without a PR costs one short "nothing to review" run.

Real runs cost money. When trying things out, pass `--model haiku`: an agent without an
explicit model uses the Claude Code default.

## What a run records

`id`, `agentId`, `projectPath`, `prompt`, `modelRequested`/`modelUsed`, `status`
(`pending → running → completed | failed | cancelled | timed_out`), timestamps and duration,
`claudeSessionId`, `permissionMode`, the exact `command` (binary, argv, cwd; the prompt is sent on stdin, so it is not in argv), `exitCode`,
`terminationReason`, `error`, `resultText`, `numTurns`, `toolCalls`, input/output/cache tokens,
`usageByModel` (the same tokens per model id), `costUsd`, `billingType`, `permissionDenials`, `deniedTools`, `mcp` (mounted, used, allow-listed but missing),
`humanIntervention`, `contextExhausted`, `errorCode`/`errorFamily`/`errorDetail`, `scheduleId`, `logPath`, `lastEventAt` (when the run last produced output, refreshed at most every 15 s; the dashboard's silent-run flag), `phases` (the main pass and,
after a budget exhaustion, the [wrap-up pass](agents.md#budget-reserve-and-wrap-up-pass)), `resumedFromRunId` (the run whose session it resumed, see [resume once](schedules.md#resume-once-on-failure)),
`agentHash` and `claudeCodeVersion` (the eval bundle, below).

The eval bundle says exactly what ran, so runs can be compared like with like: `modelUsed`, `agentHash`
and `claudeCodeVersion`. `agentHash` is a 12-character hash taken when the run starts: the agent's
loaded spec (every frontmatter field and the system prompt, not the file's location) and, for a
[link](agents.md) agent, the content of the project's `.claude/agents/<claude_agent>.md`. Two runs
with the same hash ran the same agent; editing either file changes it. `claudeCodeVersion` comes
from the child's `init` line. Both are null for runs recorded before they existed.

Token totals come from the result line's `modelUsage`, summed over every model, so they include
the tokens of subagents; the result's own `usage` counts the main session only and is used just
when `modelUsage` is missing (then `usageByModel` is null). `modelUsed` is `mixed` when tokens were
spent on more than one model (a subagent on another model), otherwise the model that ran.
With a wrap-up pass the totals and `usageByModel` cover both passes; a pass without `modelUsage`
counts under its own model, and when that is unknown `usageByModel` is null rather than partial.
The dashboard's per-model breakdown counts a `mixed` run under the model it requested.

`billingType` is set when the run spawns: `api` when the child's environment has an
`ANTHROPIC_API_KEY` (Claude Code bills that key per token), `subscription` otherwise (`costUsd`
is then what Claude Code reports, not what you are billed). It is null for runs recorded before it
existed. The dashboard marks subscription costs "reported, not billed".

A cost is named after what it is, never after a setting. `runs`, `run-info`, `list_runs` and
`get_run` add `costLabel` to each run: `Cost` when it is billed (`billingType: api`), `API value`
otherwise (a subscription run, or one recorded before `billingType` existed). `list_runs` also
returns `cost`, the listed runs summed by billing type (`apiUsd` billed, `subscriptionUsd` the API
value of subscription usage) with the wording to show: `heading` is `Spent` when every run is
billed, `Usage (API value)` when none is (`note`: included in your Claude subscription), `Spent and
usage` when both kinds are listed. `runs` prints the same total as one line on stderr (stdout stays
the JSON array), for example `Usage (API value): $3.2 over 20 runs, included in your Claude
subscription`.

`contextExhausted` comes only from structured signals (termination reason, result subtype,
stop reason, or the error text of a failed run), never from scanning the result's prose.

`errorCode` says why a run failed, as a code a script can act on; `errorFamily` groups the codes
by what to do about them. Same rule as `contextExhausted`: structured fields and a failed run's
error text only (when Claude Code flagged its result as an error, or there was no result line;
a non-zero exit after a non-error result is not scanned). Never set on a cancelled or timed-out
run. Null when the failure matches no code, and for runs recorded before it existed.

| `errorCode` | `errorFamily` | From |
|---|---|---|
| `auth_required` | `setup` | "Not logged in", "Please run /login", invalid API key, expired OAuth token; `errorDetail.loginUrl` when the message gives a URL |
| `model_not_found` | `setup` | "issue with the selected model", a model that does not exist, `not_found_error` on a model |
| `max_turns_exhausted` | `limit` | result subtype or terminal reason `max_turns` (`error_max_turns`) |
| `provider_quota` | `limit` | usage limit reached / "hit your limit"; `errorDetail.retryNotBefore` (ISO) from `limit reached\|<epoch>`, "resets at <ISO>" or "resets 3pm (Europe/London)" |
| `transient_upstream` | `transient` | API errors 429, 503, 529, `overloaded`, `rate_limit_error`: a later retry may work |
| `refusal` | `refusal` | `stop_reason: refusal`, the one code a completed (exit 0) run can carry |

`duskfleet runs` adds `needsReview` and `reviewReasons` per run (see
[dashboard](dashboard.md#needs-review)); `duskfleet schedules` adds `lastRun` per schedule.
