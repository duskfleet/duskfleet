# CLI

The CLI uses the same orchestration code as the MCP server and is the quickest way to test.
`npm run cli --` is shorthand for `node packages/mcp/dist/cli.js`.

```bash
npm run cli -- doctor                                     # Claude binary, version, config and data paths
npm run cli -- run --project ~/Documents/Projects/my-app -- "Add a README section describing the build"
npm run cli -- run --project my-app --agent my-reviewer --model sonnet -- "Review src/ for obvious bugs"   # registered id or path (--project-id is the explicit form)
npm run cli -- run --no-wait --project /path -- "..."     # return immediately (see the note below)
npm run cli -- runs --status completed --limit 10
npm run cli -- run-info <run_id> --events   # includes subagents; --events adds the timeline
npm run cli -- agents
npm run cli -- projects
npm run cli -- schedules
npm run cli -- schedules run-now "pr review"              # schedule id or name; the lease holder fires it on its next tick
npm run cli -- serve                                      # long-running scheduler process
npm run cli -- install-service [--print]                  # register `serve` with launchd / systemd --user / Task Scheduler
npm run cli -- uninstall-service
npm run cli -- tools                                      # the MCP tool catalogue
```

`doctor` also reports the scheduler: whether something is ticking, which kind of process holds
the lease (`serve`, `mcp`, `cli`) and whether the service is installed and running. See
[Schedules](schedules.md#who-ticks) for the service.

Each run writes a raw event log to `data/logs/<run_id>.jsonl` and a structured row to SQLite.

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
# Ask DuskFleet to review the PR of the branch being pushed. The run starts on the
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
`claudeSessionId`, `permissionMode`, the exact `command` (binary, argv, cwd), `exitCode`,
`terminationReason`, `error`, `resultText`, `numTurns`, `toolCalls`, input/output/cache tokens,
`costUsd`, `permissionDenials`, `deniedTools`, `mcp` (mounted, used, allow-listed but missing),
`humanIntervention`, `contextExhausted`, `scheduleId`, `logPath`.

`contextExhausted` comes only from structured signals (termination reason, result subtype,
stop reason, or the error text of a failed run), never from scanning the result's prose.
