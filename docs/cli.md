# CLI

The CLI uses the same orchestration code as the MCP server and is the quickest way to test.
`npm run cli --` is shorthand for `node packages/mcp/dist/cli.js`.

```bash
npm run cli -- doctor                                     # Claude binary, version, config and data paths
npm run cli -- doctor --probe                             # plus one real hello run on haiku (costs cents)
npm run cli -- run --project ~/Documents/Projects/my-app -- "Add a README section describing the build"
npm run cli -- run --project my-app --agent my-reviewer --model sonnet -- "Review src/ for obvious bugs"   # registered id or path (--project-id is the explicit form)
npm run cli -- run --no-wait --project /path -- "..."     # return immediately (see the note below)
npm run cli -- runs --status completed --limit 10
npm run cli -- run-info <run_id> --events   # includes subagents; --events adds the timeline
npm run cli -- repair-subagents             # backfill subagent rows of finished runs from their logs
npm run cli -- agents                                     # empty list + a hint to agents create on a fresh install
npm run cli -- agents create fixer --model haiku -- "You fix the failing test in this project. ..."   # see below
npm run cli -- projects
npm run cli -- schedules
npm run cli -- schedules run-now "pr review"              # schedule id or name; the lease holder fires it on its next tick
npm run cli -- budgets                                    # monthly budgets with this month's spend and state
npm run cli -- budgets set project my-app --amount 50 [--warn 80] [--no-hard-stop]   # or: global | agent <id>
npm run cli -- budgets delete <budget id>
npm run cli -- serve                                      # long-running scheduler process
npm run cli -- install-service [--print]                  # register `serve` with launchd / systemd --user / Task Scheduler
npm run cli -- uninstall-service
npm run cli -- tools                                      # the MCP tool catalogue
npm run cli -- --help                                     # the usage (also -h); no config needed
npm run cli -- --version                                  # the package version (also -v); duskfleet-mcp --version too
```

`duskfleet` with no arguments prints the usage on stderr and exits 2; `--help` prints it on
stdout and exits 0. Both end with `First time here? Run: npx duskfleet init`, and so does the
error of any command that finds no config (no `config/duskfleet.yaml` above the CLI, or none in
the directory `DUSKFLEET_CONFIG` names). `--version` prints the version of the installed
`duskfleet` package and needs neither a config nor Node 24.

## First run

Duskfleet ships no starter agent and `default_agent` is `null`, so a run needs `--agent`. The
README Quick start creates one, then runs it:

```bash
npm run cli -- doctor
npm run cli -- agents create fixer --model haiku -- "You fix the failing test in this project. Run the tests, read the failure, change the minimum code, run them again. No git, no installs."
npm run cli -- run --project /abs/path/to/scratch-project --agent fixer -- "Fix the failing test"
```

A run with no agent, when none exists, fails with
`Known agents: (none: no agent file in <config>/agents or <user agents dir>; create one with "agents create <id>")`.

## agents create

`agents create <id> [flags] -- "<system prompt>"` writes an **own** agent (the prompt is its
persona) to `user_agents_dir` (`data/agents/<id>.md`), the same file and the same checks as the
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

`doctor` prints the effective `path` used to find `claude` and passed to runs; `pathDefaulted`
is true on macOS when the inherited `PATH` was missing or minimal (a GUI-launched host) and the usual
install directories were put in front ([Troubleshooting](troubleshooting.md)).

`doctor` also reports the scheduler: whether something is ticking, which kind of process holds
the lease (`serve`, `mcp`, `cli`) and whether the service is installed and running. See
[Schedules](schedules.md#who-ticks) for the service.

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
same field as `get_run` ([how it works](how-it-works.md#what-gets-recorded)).

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
