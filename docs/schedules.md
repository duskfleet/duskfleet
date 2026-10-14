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

Any DuskFleet process can: the MCP server that Claude Desktop or Claude Code keeps alive, or
`duskfleet serve`, a plain long-running process:

```bash
npm run cli -- serve
```

A SQLite lease makes sure only one of them fires at a time; the others stand by and take over
when the holder stops. The lease records the kind of process (`serve@host:pid`, `mcp@host:pid`);
the dashboard's Schedules page and `duskfleet doctor` show it.

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
| Windows | Task Scheduler logon task, no time limit, restart on failure | task "DuskFleet Scheduler", XML kept under `%LOCALAPPDATA%\DuskFleet` |

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
  completes is followed by fresh runs as usual;
- `list_schedules` shows the policy in force (`effectiveOnFailure`) and, when the next fire
  will be a resume, the run it resumes (`willResumeRunId`); the dashboard row shows "resume
  once on failure" and a "next: resume" badge; `run_schedule_now` and the dashboard's **Run
  now** follow the same decision.

Set it with `create_schedule` / `update_schedule` (`on_failure: resume_once | none`,
`resume_budget_usd`; `clear_on_failure: true` goes back to the agent's policy). It pairs with
the [wrap-up pass](agents.md#budget-reserve-and-wrap-up-pass): the wrap-up records where the
run stopped, the resume picks it up from there.

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

The marker is `scheduler.noop_pattern` in `duskfleet.yaml` (default
`/nothing to do|no .* in ready/i`), overridable per schedule with `noop_pattern` on
`create_schedule` / `update_schedule` (`clear_noop_pattern: true` goes back to the default).
Write it as a regex literal `/…/flags` or a plain string, matched case-insensitively. Make
the agent end with a recognisable sentence when it finds no work. Failed runs never count as
no-op: they [need review](dashboard.md#needs-review) instead.

## Policies

- A tick whose agent or project is still busy is recorded as `skipped_busy`, never queued.
- Missed ticks (nobody running) are not caught up.
- `scheduler.enabled: false` in `duskfleet.yaml` is the kill switch, re-read every tick.
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
  **Run now** on the dashboard sets `run_requested_at` on the row and the lease holder fires it
  on its next tick (the dashboard never spawns Claude). Both follow the busy rules of a tick.
