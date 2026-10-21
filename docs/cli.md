# CLI

The CLI uses the same orchestration code as the MCP server and is the quickest way to test.
`npm run cli --` is shorthand for `node packages/mcp/dist/cli.js`.

```bash
npm run cli -- doctor                                     # Claude binary, version, config and data paths
npm run cli -- doctor --probe                             # plus one real hello run on haiku (costs cents)
npm run cli -- run --project ~/Documents/Projects/my-app -- "Add a README section describing the build"
npm run cli -- run --project my-app --agent my-reviewer --model sonnet -- "Review src/ for obvious bugs"   # registered id or path (--project-id is the explicit form)
npm run cli -- run --no-wait --project /path -- "..."     # return immediately
npm run cli -- runs --status completed --limit 10
npm run cli -- run-info <run_id> --events   # includes subagents; --events adds the timeline
npm run cli -- repair-subagents             # backfill subagent rows of finished runs from their logs
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

`doctor --probe` adds a live check that `claude --version` cannot do: one minimal real run
(`--model haiku`, a few cents at most, capped by `--max-budget-usd 0.05`; the command says so on
stderr before spending). It runs in an empty temporary directory with the same unattended
envelope as every run (`setting_sources`, strict MCP, no permission prompts, no tools allowed)
and a timeout of `claude.default_timeout_minutes`, at most 2 minutes. It records no run. The
`probe` field reports the outcome, cost and an `advice` line: not logged in (expired auth), no
result before the timeout (a hook or prompt blocking the headless child), or a process that kept
running after its result (a user-level Stop hook). `doctor` exits 1 when the probe fails.

Each run writes a raw event log to `data/logs/<run_id>.jsonl` and a structured row to SQLite.

Real runs cost money. When trying things out, pass `--model haiku`: an agent without an
explicit model uses the Claude Code default.

## What a run records

`id`, `agentId`, `projectPath`, `prompt`, `modelRequested`/`modelUsed`, `status`
(`pending → running → completed | failed | cancelled | timed_out`), timestamps and duration,
`claudeSessionId`, `permissionMode`, the exact `command` (binary, argv, cwd), `exitCode`,
`terminationReason`, `error`, `resultText`, `numTurns`, `toolCalls`, input/output/cache tokens,
`usageByModel` (the same tokens per model id), `costUsd`, `billingType`, `permissionDenials`, `deniedTools`, `mcp` (mounted, used, allow-listed but missing),
`humanIntervention`, `contextExhausted`, `scheduleId`, `logPath`, `phases` (the main pass and,
after a budget exhaustion, the [wrap-up pass](agents.md#budget-reserve-and-wrap-up-pass)), `resumedFromRunId` (the run whose session it resumed, see [resume once](schedules.md#resume-once-on-failure)).

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

`duskfleet runs` adds `needsReview` and `reviewReasons` per run (see
[dashboard](dashboard.md#needs-review)); `duskfleet schedules` adds `lastRun` per schedule.
