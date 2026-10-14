# CLI

The CLI uses the same orchestration code as the MCP server and is the quickest way to test.
`npm run cli --` is shorthand for `node packages/mcp/dist/cli.js`.

```bash
npm run cli -- doctor                                     # Claude binary, version, config and data paths
npm run cli -- run --project ~/Documents/Projects/my-app -- "Add a README section describing the build"
npm run cli -- run --project-id my-app --agent my-reviewer --model sonnet -- "Review src/ for obvious bugs"
npm run cli -- run --no-wait --project /path -- "..."     # return immediately
npm run cli -- runs --status completed --limit 10
npm run cli -- run-info <run_id> --events   # includes subagents; --events adds the timeline
npm run cli -- agents
npm run cli -- projects
npm run cli -- schedules
npm run cli -- serve                                      # long-running scheduler process
npm run cli -- install-service [--print]                  # register `serve` with launchd / systemd --user / Task Scheduler
npm run cli -- uninstall-service
npm run cli -- tools                                      # the MCP tool catalogue
```

`doctor` also reports the scheduler: whether something is ticking, which kind of process holds
the lease (`serve`, `mcp`, `cli`) and whether the service is installed and running. See
[Schedules](schedules.md#who-ticks) for the service.

Each run writes a raw event log to `data/logs/<run_id>.jsonl` and a structured row to SQLite.

Real runs cost money. When trying things out, pass `--model haiku`: an agent without an
explicit model uses the Claude Code default.

## What a run records

`id`, `agentId`, `projectPath`, `prompt`, `modelRequested`/`modelUsed`, `status`
(`pending → running → completed | failed | cancelled | timed_out`), timestamps and duration,
`claudeSessionId`, `permissionMode`, the exact `command` (binary, argv, cwd), `exitCode`,
`terminationReason`, `error`, `resultText`, `numTurns`, `toolCalls`, input/output/cache tokens,
`costUsd`, `permissionDenials`, `deniedTools`, `mcp` (mounted, used, allow-listed but missing),
`humanIntervention`, `contextExhausted`, `scheduleId`, `logPath`, `phases` (the main pass and,
after a budget exhaustion, the [wrap-up pass](agents.md#budget-reserve-and-wrap-up-pass)).

`contextExhausted` comes only from structured signals (termination reason, result subtype,
stop reason, or the error text of a failed run), never from scanning the result's prose.

`duskfleet runs` adds `needsReview` and `reviewReasons` per run (see
[dashboard](dashboard.md#needs-review)); `duskfleet schedules` adds `lastRun` per schedule.
