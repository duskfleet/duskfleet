# Troubleshooting

Sections: [Install and doctor](#install-and-doctor) · [Runs](#runs) ·
[Unattended runs](#unattended-runs) · [Scheduler and service](#scheduler-and-service) ·
[Dashboard](#dashboard).

For `claude -p` scheduled by hand (cron, launchd, systemd) rather than through Duskfleet, see
the guide [Run Claude Code on a schedule on your own machine](guides/run-claude-code-on-a-schedule.md).

## Install and doctor

- **`Duskfleet needs Node 24 or newer; you have vX.Y.Z`** (exit code 1, from the CLI and the MCP
  server alike): Duskfleet uses the built-in `node:sqlite`, so it refuses older runtimes before
  loading anything. Switch to Node 24 (`nvm use` reads `.nvmrc`; `fnm` and others read
  `.node-version`) and run `npm run build` again. An MCP host started with an absolute `node`
  path keeps using that binary: point it at a Node 24 one.
- **`doctor` cannot find `claude`**: set `claude.binary` in `duskfleet.yaml` or `CLAUDE_BIN`.
  On macOS, GUI-launched hosts (Claude Desktop, launchd) start with a minimal `PATH` (only
  `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, or none): DuskFleet then puts
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` in front, to find `claude` and for every
  process it starts (runs, schedule gate commands, the git reads of a run's diff). `doctor`
  prints the effective `path` and `pathDefaulted: true` when that happened. On Linux and
  Windows (experimental, [platform support](../README.md#platform-support)) the `PATH` is used
  as it is, even a minimal one. Such hosts also do not expand `~` in
  `claude_desktop_config.json` ("No executable file at ~/..."): use absolute paths.
- **Is `claude` logged in, will a hook block scheduled runs?** `npm run cli -- doctor --probe`
  makes one real hello run on haiku (cents) and says which of the two it hit
  ([CLI](cli.md)).
- **New code is not picked up**: the MCP host keeps the server process alive. After
  `npm run build`, restart Claude Desktop or the Claude Code session. Config changes need no restart.
- **`npm install` fails on root-owned files in `~/.npm`**: use `npm install --cache "$TMPDIR/npm-cache"`.

## Runs

- **A run never finishes although the agent already answered**: a user-level hook in
  `~/.claude/settings.json` (for example a `Stop` hook that shows a desktop notification) may be
  blocking in a headless context. Set `claude.setting_sources: [project, local]` so runs skip
  user-level settings, or make the hook non-blocking. Inspect `data/logs/<run_id>.jsonl`: if the
  last line is an `assistant` message with no `result` line, this is the cause. Once the
  `result` line is out, Duskfleet does not wait: each run leads its own process group, and if the
  process (or anything it spawned that still holds its output, such as a hook) is alive 5 s
  later, the group gets SIGTERM, then SIGKILL after 5 s more. The run keeps the result's verdict
  and its events carry a note "still running 5 s after the result line". Keep
  `setting_sources` anyway: a hook that blocks before the result is not covered.
- **Runs failed with "orphaned: owning process ... is gone"**: the Duskfleet process that
  started them (named in the error) exited or crashed while they were running. Runs of a live
  process (another MCP server, `serve`) are never touched. Resume the Claude session with the
  `resumeCommand` from `get_run` if you want to continue the work. "(unrecorded)" means the
  run was started by a build without run ownership; such a row is failed only once it is older
  than the longest configured timeout plus a minute, since it may come from a process still on
  that build (a `serve` not restarted after `npm run build`: re-run `install-service`).
- **A run stays `running` although nothing is running**: recovery only fails a run when its
  owner (`role@host:pid`) is provably gone. Two cases it cannot see: the owner's pid was
  reused by an unrelated live process, or the machine's hostname changed since the run
  started (macOS renames `Mac.local` to `Mac-2.local` on a name clash), so the owner looks like
  another host. Without `scheduler.enabled` (or with no process holding the lease) the
  periodic sweep does not run either; only the next start of a Duskfleet process recovers.
  Clean up by hand: stop the owning process if it is still alive, then mark the row failed in
  `data/duskfleet.db`, e.g.
  `sqlite3 data/duskfleet.db "UPDATE runs SET status='failed', error='manual cleanup' WHERE id='<run id>' AND status='running'"`.
- **`cancel_run` says the run is owned by another live Duskfleet process**: the claude child
  belongs to that process (another MCP server, or `serve`); cancel it there, or stop that process
  and the run is recovered as orphaned.

## Unattended runs

Nobody answers a prompt in an unattended run, so the three ways it goes wrong first are a tool
it was not allowed, a limit it ran into, and a schedule that never started it. Each entry
below gives the symptom, where to see it, the cause and the fix. The reason names are the
`reviewReasons` stored on the run ([needs review](dashboard.md#needs-review)) and the outcomes
the scheduler records on a firing ([schedules](schedules.md#policies)).

### Permission denial

- **Symptom**: the run is `completed` but **needs review** (amber), reason `permission_denied`.
  The task is often half-done: the agent worked around the refused call or stopped there.
- **Where to see it**: the run detail page (the "Needs review" callout and the denied calls,
  each with its command or file); `npm run cli -- run-info <run_id>` and `get_run`
  (`deniedTools`, `permissionDenials`, `reviewReasons`); `list_runs` / `duskfleet runs`
  (`needsReview`, `reviewReasons`).
- **Causes and fixes** (fix the agent's `allowed_tools`, not the prompt; see
  [permissions in unattended runs](agents.md#permissions-in-unattended-runs)):
  - **The tool is not in `allowed_tools`.** Everything the agent needs must be in its own
    frontmatter: `--permission-prompts none` ignores the target project's `.claude/settings`
    allow-lists and confines file tools (and Bash paths) to the project directory. Use
    `add_dirs` to reach other directories.
  - **The agent cannot run tests or use Bash**: `permission_mode: acceptEdits` does not allow
    Bash. Add entries such as `Bash(npm test:*)` to `allowed_tools`.
  - **An allow-listed command is still denied**: a prefix rule matches at a word boundary, and
    a colon is not one, so `Bash(npm run lint:*)` does not allow `npm run lint:fix`: list such
    scripts one by one (`Bash(npm run lint:fix)`). A variable in front (`FOO=1 npm test`) is a
    different command. Some shapes are refused whatever the rules say: an unquoted
    `@{upstream}`, a GraphQL fragment in `gh api graphql`, and a quoted argument with a line
    starting with `#` (pass a long PR body with `--body-file`). Verified with Claude Code 2.1.303.
  - **A `plan` agent does nothing**: `plan` blocks Bash, MCP and writes regardless of allow-lists.
    Use `dontAsk` with `disallowed_tools: [Edit, Write, NotebookEdit]` for read-only agents.
  - **`bypassPermissions` rejected**: Claude Code refuses it together with
    `--permission-prompts none`, so Duskfleet rejects it before spawning.
    `claude.allow_bypass_permissions: true` does not change that: the option exists, but
    unattended runs still refuse `bypassPermissions` (enabling it only changes the error
    message). Use `dontAsk` with an `allowed_tools` list instead.
- **An allow-listed MCP server never mounted** (reason `mcp_missing`, the same amber badge):
  `mcp.allowListedMissing` on the run names the server. Fix the agent's `allowed_tools` (or
  `inherit_mcp`). One exception: when the mounted list has no claude.ai connector at all, Claude
  Code came up without them and the allow-list is fine. Duskfleet restarts the process once when
  it sees that at init (note "restarted once" on the run); a run flagged anyway had no luck
  twice. Run it again.

### Budget exhausted or timed out

- **Symptom**: the run is red, status `failed` with `terminationReason: budget_exhausted`
  (reason `budget_exhausted`), or status `timed_out` (reason `timed_out`).
- **Where to see it**: the run detail (the "Needs review" callout, the limits row with timeout,
  budget and wrap-up reserve, and the `phases` list), `run-info` / `get_run`
  (`terminationReason`, `wrapUp`, `phases`), and on the schedule row as how its last run ended.
- **Cause**: `max_budget_usd` (default `claude.default_max_budget_usd`) caps the spend of one
  run; `timeout_minutes` (default `claude.default_timeout_minutes`) caps its duration. Part of
  the budget, `wrap_up_reserve_usd` (default 10% with a $0.50 floor, `0` = off), is held back:
  when the main pass ends `budget_exhausted`, one wrap-up pass resumes the session to record
  where it stopped ([budget reserve and wrap-up pass](agents.md#budget-reserve-and-wrap-up-pass)).
  The run stays `failed`: the task was not done.
- **Is the result half-done?** Assume so. With a wrap-up pass, its final message (`resultText`)
  says where the agent stopped. A timeout, or a budget stop with the reserve at `0`, may have
  left unrecorded work in the checkout or a ticket: look at the run's diff and timeline before
  starting it again.
- **Fix**: raise `max_budget_usd` or `timeout_minutes` in the agent's frontmatter, or split the
  task into smaller prompts. For a schedule, `on_failure: resume_once` (with `resume_budget_usd`)
  resumes the session once on the next tick instead of starting fresh
  ([resume once on failure](schedules.md#resume-once-on-failure)).

### Runs skipped by gates

A schedule that "did not run" was considered and refused before anything was spawned. The
outcome is recorded on the firing: `lastOutcome` / `lastError` in `list_schedules` and
`duskfleet schedules`, the firing strip and counters on the dashboard's **Schedules** page.

- **`skipped_busy`**: the agent or the project already had a run (`agent busy: ...` /
  `project busy: ...`). By default one run per project directory (`max_concurrent_per_project`)
  and one per agent (`max_concurrent_per_agent`); `max_concurrent_runs` is the hard cap. Busy
  ticks are never queued: the next tick tries again. Fix: if the agent can safely run in
  parallel, set `max_concurrent: <n>`; if it never edits the checkout (read-only, or its own
  worktree), set `isolated: true` so the project guard does not apply
  ([running an agent in parallel](agents.md#running-an-agent-in-parallel)). A long run that
  keeps the agent busy for many ticks is the real problem: check its timeout.
- **`skipped_daily_cap`**: the agent (or its gate agent) reached `max_daily_runs` or
  `max_daily_cost_usd` for the UTC day (`daily cap: agent <id> ...`). It lifts at 00:00 UTC,
  whatever the schedule's time zone. Fix: raise or remove the cap
  ([daily caps](agents.md#daily-caps)).
- **`skipped_budget`**: a hard-stop monthly budget covering the run is spent; the scope's
  schedules are paused too and stay paused. Fix: raise the budget, then resume the schedules by
  hand ([monthly budgets](agents.md#monthly-budgets)).
- **`skipped_gate`**: the schedule's gate found no work; its reason is `lastError`
  ([gates](schedules.md#gates-skip-cheaply-when-there-is-no-work)).
- **`auto_paused`**: the last `scheduler.auto_pause_after` runs were all empty or needed
  review; `pausedReason` says which. Fix the cause of those runs, then resume
  ([auto-pause](schedules.md#auto-pause)).
- **Nothing recorded at all**: no process ticked. `scheduler.enabled: false` in
  `duskfleet.yaml` is the kill switch (the holder releases the lease and nothing fires), a
  `pause_scheduler` pause may be in force (`scheduler.pause` in `list_schedules`), or no
  Duskfleet process holds the lease: see [Scheduler and service](#scheduler-and-service) below
  for a service that is not running or runs old code.

### Context exhausted and orphaned runs

- **`context_exhausted`**: the run reported, as a structured signal, that its context window
  ran out. Split the task or have the agent hand work to subagents; see
  [needs review](dashboard.md#needs-review).
- **`orphaned`**: the Duskfleet process that owned the run went away while it was running: see
  the orphaned entries under [Runs](#runs).

## Scheduler and service

- **Two Duskfleet processes, schedules fire once**: that is the SQLite lease at work. The
  dashboard's Schedules page and `doctor` show the holder and its kind (`serve`, `mcp`).
- **"Ticking from an unknown process", Run now never fires, the service is running**: a
  `packages/mcp/dist/index.js` started before your last build (an MCP host keeps it alive)
  holds the lease with old code. Since the `serve` role preempts such holders, `install-service`
  (which restarts the service) fixes it; on a service older than that, kill the stale
  `index.js` processes or restart the hosts that spawned them.
- **Schedules stop when Claude Desktop closes**: only the MCP server was ticking. Install the
  service once with `npm run cli -- install-service`; `doctor` reports `scheduler.service`.
  If the service is running but nothing fires, read `data/logs/serve.log` (the service writes
  there, not to the terminal); a `claude` not found there means the unit's PATH / `CLAUDE_BIN`
  are stale, re-run `install-service`.
- **The service runs old code**: `install-service` again after every `npm run build` (it
  restarts the process), or `launchctl kickstart -k gui/$(id -u)/com.duskfleet.scheduler` /
  `systemctl --user restart duskfleet.service`.

## Dashboard

- **A run or a schedule row is amber or red**: the badge title names the stored review reasons.
  Find the reason in [Unattended runs](#unattended-runs): a
  [permission denial](#permission-denial), a [budget or time limit](#budget-exhausted-or-timed-out),
  or a [context exhausted or orphaned run](#context-exhausted-and-orphaned-runs).
- **A schedule shows skipped ticks and no runs**: see [runs skipped by gates](#runs-skipped-by-gates).
