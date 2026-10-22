# Schedules (cron)

Schedules live in the database and are managed over MCP (`create_schedule`, `update_schedule`,
`delete_schedule`, `run_schedule_now`, `list_schedules`) or read on the dashboard's **Schedules**
page and with `duskfleet schedules` on the CLI. A schedule is: agent, prompt, 5-field cron,
IANA time zone (default `Europe/London`), optional project (not needed when the agent is bound
to one) and model override.

```
0 8-20 * * 1-5     weekdays 08–20 on the hour
30 8-20 * * 1-5    weekdays 08–20 at :30
45 7 * * 1-5       weekdays at 07:45
```

The cron parser is in-house (no dependency) and DST-safe: it re-derives local time per
candidate minute, so a schedule at 08:00 fires at 08:00 on both sides of a clock change.

## Who ticks

Any Duskfleet process can: the MCP server that Claude Desktop or Claude Code keeps alive, or
`duskfleet serve`, a plain long-running process:

```bash
npm run cli -- serve
```

A SQLite lease makes sure only one of them fires at a time; the others stand by and take over
when the holder stops. Each due tick is also claimed with a compare-and-set on its
`next_run_at` before it fires, so even a lease that changes hands in the middle of a tick cannot
fire the same tick twice: the process that loses the claim records nothing. The lease records the kind of process (`serve@host:pid`, `mcp@host:pid`);
the dashboard's Schedules page and `duskfleet doctor` show it. That page groups schedules by
the project they run on: the schedule's own `project_id`, else the project its agent is bound
to (projects alphabetically, "no project" last, normally empty: only a schedule whose agent was
deleted lands there). Each group is headed by the project link, its schedule count and how
many are paused. `list_schedules` and `duskfleet schedules` return the same value as
`effectiveProjectId`; `projectId` stays the stored one (null for a bound agent).

**Relying on the MCP server alone means schedules stop when Claude Desktop or Claude Code
closes.** To run them unattended, register `serve` as a per-user service once:

```bash
npm run cli -- install-service            # writes the unit from your real paths and starts it
npm run cli -- install-service --print    # only show the unit
npm run cli -- uninstall-service
npm run cli -- doctor                     # "scheduler.service" says whether it is running
```

| Platform | Mechanism | Unit |
|---|---|---|
| macOS | launchd LaunchAgent (`RunAtLoad`, `KeepAlive`) | `~/Library/LaunchAgents/com.duskfleet.scheduler.plist` |
| Linux | systemd user unit (`Restart=always`) | `~/.config/systemd/user/duskfleet.service` |
| Windows | Task Scheduler logon task, no time limit, restart on failure | task "Duskfleet Scheduler", XML kept under `%LOCALAPPDATA%\Duskfleet` |

All three run as the logged-in user, so the service sees the same `claude` login as your
terminal, start at login and restart the process if it dies. They append the process output to
`data/logs/serve.log`. The unit carries absolute paths (node, `packages/mcp/dist/cli.js`, the
repo, the `claude` binary as `CLAUDE_BIN`) and is never versioned.

Things to know:

- `install-service` is idempotent and restarts the service. **Run it again after every
  `npm run build`**, otherwise the service keeps running the old code (same as the MCP server).
- While the machine sleeps nothing runs; missed ticks are not caught up (see Policies).
- Linux: `loginctl enable-linger $USER` keeps the unit alive when you are logged out.
- Windows support is implemented but has not been exercised by the maintainers: check
  `data/logs/serve.log` if `doctor` reports the task running but nothing fires.
- The MCP server keeps ticking as a fallback: stop the service and it takes over after three
  ticks (90 s by default).
- `serve` has priority: on its first tick it takes the lease from a live `mcp` / `cli` /
  role-less holder instead of waiting for it to expire, and those never take it back while
  `serve` renews it. Without this an MCP server started before your last `npm run build`
  (a Claude Desktop or Claude Code session keeps it alive, running the old code) could hold
  the lease for days; the dashboard badge showed `host:pid` without a role. Two `serve`
  processes still share it first come, first served. The MCP server itself cannot be
  upgraded in place: after a build, restart the hosts that spawned it or kill the stale
  `packages/mcp/dist/index.js` processes, then `install-service`.

## Resume once on failure

By default a schedule whose run died out of budget or out of time starts fresh on its next
tick, and whatever the dead run half-did is left to the new one to discover. With
`on_failure: resume_once` (on the schedule, or inherited from the agent's frontmatter) the next
tick instead **resumes the session** of the run it last started, once:

- it applies when that run ended `budget_exhausted` or `timed_out`; a plain failure, a
  cancel or an orphan start fresh;
- the retry is a normal run of the schedule (`scheduleId`, WIP guards, `skipped_busy` if the
  agent is still busy), recorded in the firing log as `resumed` and counted as a fire; it
  runs `claude --resume <session>` with `resume_budget_usd` (schedule, else agent, else
  `max_budget_usd`) and a prompt that says to check what was already done, finish, and
  record the outcome;
- **once**: a retry that fails again is final, the tick after starts fresh; a retry that
  completes is followed by fresh runs as usual. `resumeRun` refuses a run that is itself a
  resume, and the retry row is the claim (`resumed_from_run_id` is unique), so two processes
  firing the same schedule at once cannot both resume it. A retry that fails to spawn gives
  the claim back;
- editing the schedule's agent, project, prompt or model after the failure cancels the
  resume: the next fire starts fresh with the new values. A resume refused for any other
  reason than busy (the agent was deleted, the project unregistered) also starts fresh, with
  a note on the new run, so it cannot block the schedule;
- `list_schedules` shows the policy in force (`effectiveOnFailure`) and, when the next fire
  will be a resume, the run it resumes (`willResumeRunId`); the dashboard row shows "resume
  once on failure" and a "next: resume" badge; `run_schedule_now` and the dashboard's **Run
  now** follow the same decision.

Set it with `create_schedule` / `update_schedule` (`on_failure: resume_once | none`,
`resume_budget_usd`; `clear_on_failure: true` goes back to the agent's policy). It pairs with
the [wrap-up pass](agents.md#budget-reserve-and-wrap-up-pass): the wrap-up records where the
run stopped, the resume picks it up from there.

## Gates: skip cheaply when there is no work

A gate is a cheap check that runs before the real run on every tick, so a schedule that finds
no work skips for (almost) nothing instead of paying a full agent session to say so. One per
schedule, set with `gate` on `create_schedule` / `update_schedule` (`clear_gate: true` removes
it). Two kinds:

**Command gate**: a shell command run with `sh -c` in the project directory.

```
create_schedule { …, "gate": { "command": "./scripts/has-ready-work.sh", "timeout_seconds": 60 } }
```

Exit 0 means there is work and the real run starts. Exit 1-125 skips the tick: the
firing is `skipped_gate` and the command's stdout (else stderr) is kept as the reason
(`lastError`, the firing log, the dashboard row). A broken gate is an `error`, never a skip:
exit 126 (not executable), 127 (command not found: a typo, or a tool missing from the minimal
`PATH` a launchd / systemd service gets), death by a signal, a timeout (default 60 s, max 600)
or a command that cannot start. The command runs in its own process group and a timeout kills
the whole group, so a hanging pipeline (`gh … | jq …`) cannot stall the scheduler. It costs
nothing. Whatever "work" means is up to the command: a ticket query through a CLI, a `git log`
since the last tag, a file in an inbox folder.

**Agent gate**: a cheap agent run with its own prompt and budget.

```
create_schedule { …, "gate": { "agent": { "agent_id": "work-checker", "prompt": "Is there a Ready ticket for you? If not, end your answer with NO_WORK alone on the last line.", "budget_usd": 0.3, "model": "haiku", "marker": "NO_WORK" } } }
```

It is recorded as a run of kind `gate` (same schedule, same project, no wrap-up reserve). When
the last line of its final message is `marker` (default `NO_WORK`; case-insensitive, markdown
emphasis and a trailing full stop are ignored) the tick is `skipped_gate`, with the message as
the reason. A marker mentioned anywhere else ("… so this is not NO_WORK") does not count:
the real run starts. A gate run that fails or times out is an `error` and the real run does not
start; one still running past its agent's timeout is cancelled, and its cost is recorded either
way. The gate agent must be allowed to run on the schedule's project; give it `allowed_tools`
for what it checks, and a cheap `model`.

Rules:

- The busy check comes first: a tick whose agent or project is busy is `skipped_busy` without
  running the gate. Then the agent's daily caps: over a cap the tick is `skipped_daily_cap`
  without running the gate. Then the monthly budgets: a spent hard-stop budget makes it
  `skipped_budget`, again without running the gate.
- A gated fire runs in the background of the tick: a gate can take minutes, and the tick goes
  on renewing the lease and serving other schedules and **Run now** requests. The fire claims
  its tick (`next_run_at` moves on) before the gate starts, so no other process fires it again
  meanwhile, and a second fire of the same schedule while its gate runs is `skipped_busy`.
- A stored gate that cannot be read (a hand-edited `gate_json`) makes every fire an `error`
  until the gate is set again or cleared; it never silently runs ungated.
- A tick that [resumes](#resume-once-on-failure) a failed run skips the gate: the work exists.
- `run_schedule_now` and the dashboard's **Run now** go through the gate (an agent gate is
  waited for); `run_schedule_now { "skip_gate": true }` starts the real run directly.
- Gate cost is counted apart from run cost. Each firing records `gateRunId` / `gateCostUsd`,
  `idle7d` adds `gateChecks`, `gateSkips` and `gateCostUsd` (not included in `costUsd`),
  `list_runs { "kind": "gate" }` lists the gate runs, and the dashboard shows "on runs / on
  gates" under Spent and the gate spend per schedule.

## Idle cost

A schedule that fires every hour mostly finds nothing to do, and each of those runs still
costs money: on 2026-10-14, 49 of 50 scheduled runs ended "nothing to do" at $0.10–0.60 each.
Every schedule therefore reports, over the last 7 days (`idle7d` in `list_schedules` and
`duskfleet schedules`, the **Idle · 7 d** column on the dashboard):

| Field | Meaning |
|---|---|
| `ticks` | every time the schedule was considered (fired, skipped, error) |
| `fires` | ticks that started a run (`started` + `resumed`) |
| `runs`, `costUsd` | runs of the schedule and what they cost |
| `noopRuns`, `noopCostUsd` | completed runs whose final message matched the no-op marker, and their cost |
| `noopPattern`, `noopPatternError` | the marker used, and why it could not be parsed (else `null`; then the no-op counts are 0 for that schedule only) |

The marker is `scheduler.noop_pattern` in `duskfleet.yaml` (default
`/^\s*(nothing to do|no .* in ready)/i`, anchored at the start of the message so a run that
did work and mentions "nothing to do" further down is not counted), overridable per schedule
with `noop_pattern` on `create_schedule` / `update_schedule` (`clear_noop_pattern: true` goes
back to the default). Write it as a regex literal `/…/flags` or a plain string, matched
case-insensitively; surrounding whitespace is ignored and an empty pattern is refused. It is
tested against the first 2000 characters of the final message only. An invalid
`scheduler.noop_pattern` does not break the config: it is ignored with a warning and the
default applies. `noop_pattern` and `clear_noop_pattern` in one `update_schedule` call are
refused. Make the agent start its final message with a recognisable sentence when it finds no
work. Failed runs, and completed runs that [need review](dashboard.md#needs-review) (a
permission denial, a budget or context limit, an MCP mismatch), never count as no-op, even
when they end with "nothing to do": they were blocked, not idle. The one exception is a run
whose only reason is `empty_run` (no tool call at all): a text-only "nothing to do" answer is
exactly what a no-op looks like, so it still counts.

## Auto-pause

A schedule that keeps producing nothing is paused by the scheduler itself. Before every
scheduled fire (not a manual run now), it reads the schedule's last
`scheduler.auto_pause_after` ended runs (default 5; `0` turns the check off; gate runs are not
counted). When every one of them either completed with 0 tool calls or ended
[needs review](dashboard.md#needs-review), the tick does not fire: the schedule is set
`enabled: false`, the firing is recorded as `auto_paused`, and the reason (how many runs were
empty, how many needed review, the last run's id) is stored as `pausedReason`. It shows in
`list_schedules` and `duskfleet schedules`, and as an **auto-paused** badge on the
**Schedules** page. A cancelled or clean run breaks the streak; a run still going is not
counted yet.

Resume it as any paused schedule (`update_schedule` with `enabled: true`, or **Resume** on the
dashboard): the reason is cleared, and only runs created after the pause count towards the
next streak, so the schedule gets `auto_pause_after` fresh runs before it can be paused again.
Run now still fires a paused schedule.

## Policies

Every schedule stores its two policies, so the behaviour below is explicit on the row
(`concurrencyPolicy`, `catchUpPolicy` in `list_schedules`; set with `concurrency_policy` /
`catch_up_policy` on `create_schedule` / `update_schedule`):

| Field | Values | Default |
|---|---|---|
| `concurrency_policy` | `skip_if_active` (the only one) | `skip_if_active` |
| `catch_up_policy` | `skip_missed`; `enqueue_missed_with_cap` is reserved and refused for now (planned: replay up to 3 missed ticks, never for sub-hourly schedules) | `skip_missed` |

- A tick whose agent or project is still busy is recorded as `skipped_busy`, never queued (checked before any [gate](#gates-skip-cheaply-when-there-is-no-work)).
- A tick whose agent reached its [daily cap](agents.md#daily-caps) (`max_daily_runs`,
  `max_daily_cost_usd`, UTC day) is recorded as `skipped_daily_cap`, also before any gate; a
  pending resume is not tried either. The cap lifts at 00:00 UTC.
- A tick refused by a spent hard-stop [monthly budget](agents.md#monthly-budgets) (global, its
  agent's or its project's) is recorded as `skipped_budget`, also before any gate, and every
  schedule of that budget's scope is paused: it stays paused after the month turns, until you
  resume it (`update_schedule enabled: true` or the dashboard).
- Missed ticks (nobody running) are not caught up (`skip_missed`): the schedule fires once when
  it is next considered and its next tick is computed from then.
- `scheduler.enabled: false` in `duskfleet.yaml` is the kill switch, re-read every tick.
- A schedule whose last `scheduler.auto_pause_after` runs were all empty or needs review is
  [auto-paused](#auto-pause) instead of fired.
- Every run started by a schedule carries its `scheduleId`, and the schedule carries the
  state of the run it last started (`lastRun` in `list_schedules` and `duskfleet schedules`,
  a badge on the dashboard row): `started` is only the outcome of the tick; a run that then
  failed, timed out or ran out of budget is **needs review** right on the row (see
  [dashboard](dashboard.md#needs-review)).
- New schedules are best created paused (`enabled: false`), tried once with `run_schedule_now`
  or the dashboard's **Run now**, checked on the dashboard (denials, missing MCP servers, cost)
  and only then enabled.
- Two ways to fire a schedule by hand, both outside its cron and even when paused:
  `run_schedule_now` over MCP starts the run immediately in the MCP server process;
  **Run now** on the dashboard and `duskfleet schedules run-now <id or name>` on the CLI set
  `run_requested_at` on the row and the lease holder fires it on its next tick (neither spawns
  Claude, which makes the CLI form safe to call from a git hook, see [CLI](cli.md#firing-an-agent-from-a-script-or-a-git-hook)).
  All follow the busy rules of a tick.
