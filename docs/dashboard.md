# Dashboard

```bash
npx duskfleet dashboard   # installed package: fetches @duskfleet/web once, opens http://localhost:4777
npm run web               # in a checkout: dev server on http://localhost:4777
# or: npm run build:web && npm run start -w @duskfleet/web
```

## duskfleet dashboard

```bash
duskfleet dashboard [--port 4777] [--no-open] [--no-install]
```

The dashboard is a separate npm package, `@duskfleet/web` (Next.js and React stay out of the
`duskfleet` package), published with the same version as `duskfleet`. The first time a version
of the CLI starts it, `duskfleet dashboard` runs
`npm install --prefix <dataDir>/web/<version> @duskfleet/web@<version>` (npm's progress on
stderr); later starts use that copy and need no network. It then starts the dashboard in the
foreground, bound to `127.0.0.1` on `--port` (default 4777), with the config of this CLI
(`DUSKFLEET_CONFIG`) and telemetry off, and opens `http://localhost:<port>` with `open`,
`xdg-open` or `start` unless `--no-open`. Ctrl-C stops it (exit 0). When something already
listens on that port (another dashboard, `npm run web`), the command exits 1 before installing or
starting anything and asks for another `--port`.

- **Where it lands**: `<dataDir>/web/<version>/` (`data/web/0.1.0/` with the default
  `data_dir`), with its own `node_modules` (next, react, react-dom).
- **Upgrades**: after a CLI upgrade the matching version is installed next to the old one (first
  into `<version>.<pid>.partial`, one per process); the directories of older versions are removed
  once it is installed with the right version. Two first starts of the same version at once do not
  clash: the one that finishes second reuses the other's install. A newer version (after a
  downgrade), another install's `.partial` directory and anything that is not a version stay. A
  failed install leaves the old ones in place.
- **Install fails** (offline, registry down): the command exits 1 and says how to install it by
  hand: `npm install -g @duskfleet/web@<version>`, then `duskfleet dashboard --no-install`.
  `--no-install` never installs: it uses the data directory copy, else the global package, and
  refuses one of another version.
- **Remove it**: delete `<dataDir>/web/` (and `npm uninstall -g @duskfleet/web` if you installed it
  globally). The next `duskfleet dashboard` installs it again.
- `DUSKFLEET_WEB_SPEC` replaces the npm spec of the install (a local tarball, a mirror); the
  installed package must still carry this CLI's version.

A Next.js app that reads the database the MCP server writes (SQLite WAL mode). It can run
while the MCP server is running or not; it only needs `config/` and `data/duskfleet.db`. It
has no authentication and answers on localhost only (see [Remote access](#remote-access)).
It sends no telemetry: the `dev` and `build` scripts set `NEXT_TELEMETRY_DISABLED=1` (on
Windows, an [experimental platform](../README.md#platform-support), set it in your shell first), and `start` / `duskfleet-web` (`bin/start.mjs`) default it
to `1` on every platform.

Five views, plus the [trend](#trends) of the runs. The runs list and a running run's detail auto-refresh every 3 seconds (pause button
in the nav); the other pages are static.

- **Runs**: KPI cards (clean runs, needs review, spend) computed on the current project / agent
  filter; a Project and an Agent multi-select on the search line (repeated params,
  `?project=a&project=b&agent=x`: any of the projects AND any of the agents; a single `?agent=`
  still works; each select's × drops its filter), prompt search (`?q=`), `?schedule=` and
  `?limit=` (load older).
  The KPI cards filter the list by how runs ended, `?outcome=` (real runs only, gate runs left
  out, by the stored review verdict):
  - `needs_review`: every run with a review reason (click the **Needs review** card; it also shows
    how many of them started today, UTC day like the daily caps);
  - `clean`: completed with nothing to review;
  - `completed_review`: completed, but with a review reason;
  - `failed`: failed, timed out or cancelled.

  `clean` + `completed_review` + `failed` are the finished runs (the three links of the **Clean
  runs** card); the rest of that card opens the [trend](#trends) with the same agent / project
  filter. With `needs_review` on, the card has an amber outline and splits the count into since
  midnight (UTC) and earlier, and the list heading reads "Recent · needs review". `?reason=<id>`
  (`permission_denied`, `empty_run`, `timed_out`, ...; the reason rows of the trend link there)
  keeps only the runs with that stored reason. `outcome` and
  `reason` combine with the other parameters, and "× clear filters" drops them all. Runs are identified
  by a short title (first line of the prompt); the whole row links to the detail. A running run
  that produced no stream-json output for 5 minutes shows a "no output for N min" flag (amber,
  red from 15 minutes; since the start when it never produced any). Informational only: nothing
  kills the run. The timestamp is `last_event_at`, written at most every 15 seconds.
- **Run detail**: short title, status line, duration / cost / turns / tool calls / tokens (a
  subscription run's cost is labelled "reported, not billed"; an API key run's is billed, see
  [`billingType`](cli.md#what-a-run-records); the list's cost cell says the same on hover), the
  issues (denied calls highlighted in the timeline, missing MCP servers, context exhaustion,
  the error labelled with its [`errorCode`](cli.md#what-a-run-records) and the quota reset time,
  a "Claude is not logged in" callout with the login link for `auth_required`, a refusal warning),
  the linked retry when the run resumed an earlier one or was resumed by a later one
  (`on_failure: resume_once`; the list shows "resumes ↗" / "retried ↗" flags),
  final message (long results collapse), a callout when a budget exhaustion was followed by a
  wrap-up pass (what the main pass spent, what the wrap-up cost and whether it recorded where
  it stopped; the wrap-up's own tool calls sit between `wrap-up started` / `wrap-up ended`
  rows of the timeline), a **Changes** section when the project is a git checkout (files the
  run changed with lines added / deleted, the base commit, a link to the patch at
  `/runs/<id>/diff`), event timeline with legend and grouped repeats,
  previous / next run of the same agent, a "run again" CLI command, the `claude --resume`
  command and the exact command executed. Home paths print as `~/…`; Copy buttons give the
  full value.
- **Agents**: four tiles (agents, running now, needs review, auto-paused), Project / Status
  filters, a search on id and description and a sort (last run, id, runs, clean, cost), then one
  table per project ("Any project" first), one row per agent: status (idle, running, needs review
  from the stored review reasons of its last run, or "paused · auto" when a bound schedule was
  auto-paused), id and kind, a one-line description, model, runs over 7 days with a per-day
  sparkline, clean %, cost and last run, and links to its runs and schedule. Under about 720 px
  the same row reflows into a four-line block, each number under its column label.
- **Agent** (`/agents/<id>`): everything that configures one agent. Header with kind, builtin /
  override chip, status, project, model and file; 30-day tiles (runs and cost with sparklines,
  clean %, needs review); the system prompt (own) or the link target with the project persona
  (link), expanding in place; the 5 latest runs with a Status filter; permissions (allow-list
  past 8 entries expands in place) and limits, including daily caps and the monthly budget; the
  bound schedules; and the needs-review reasons over 30 days, each bar opening Runs filtered by
  agent and reason. User agents can be deleted or unlinked here, with an inline confirmation;
  builtins are read-only. **Run now…** appears only when a schedule runs the agent and uses that
  schedule's run now (see Schedules below): the dashboard never starts a run itself.
- **Schedules**: a status strip (kill switch, lease holder and when its lease expires, next
  firing, last 7 days fired / skipped busy), then the schedules grouped by project (the
  schedule's own, else its agent's; "no project" last), one card each, titled by its agent (a link to the agent's card on Agents,
  which links its runs): cron (raw and in plain words), the schedule name, project, model, the
  [gate](schedules.md#gates-skip-cheaply-when-there-is-no-work) and on-failure policy in force, the
  prompt, the last 10 firings as squares coloured by how the run they started **ended** (clean,
  needs review from the stored review reasons, failed, running, cancelled, skipped busy, skipped by
  the gate, run gone), and a footer with the next tick (theoretical one for paused schedules), the
  fired / skipped counters, the [idle cost](schedules.md#idle-cost) over 7 days (no-op runs out of
  all runs and the dollars they cost, amber when at least half were no-ops), what the gate skipped
  and cost, and the last error. A "next: resume" badge says the next fire will resume the last run
  (`on_failure: resume_once`). Each card can be run now, paused / resumed, have its cron and time
  zone edited, or be deleted (inline confirmation); the changes go through the same validation as
  `update_schedule`. **Run now** does not start Claude from the dashboard: it marks the row and the
  process that holds the scheduler lease fires it on its next tick (within `tick_seconds`, paused
  or not, busy = skip), so it waits while no process ticks. A callout warns when only an MCP host
  ticks, with the `install-service` command. Creating a schedule and changing its agent, project,
  prompt, model, gate or on-failure policy stay on MCP (copyable `create_schedule` example).
- **Spent / Usage (API value)** (Runs page): Claude Code reports what each run would cost at API
  prices, also on a subscription, where it is usage included in the plan, not money. The tile's
  wording follows the [`billingType`](cli.md#what-a-run-records) of the runs in view, never a
  setting: all `api`, "Spent"; all `subscription`, "Usage (API value)" with "included in your
  Claude subscription"; mixed, "Spent and usage" with the billed and API value amounts on two
  lines. Runs recorded before `billingType` existed count as API value: only an API key run is
  shown as billed. The same rule names the run list's cost column, the "By model" table of
  [Costs](#costs) and the agent cards' average. The whole tile opens `/costs` with the agent /
  project filter. The tile splits into "on runs" and "on gates" once a gate agent has run; gate
  runs carry a `gate` flag in the run list and are left out of the run counts (total, clean,
  failed, needs review): a gate is a yes/no check, not work. When runs hit the provider's usage
  limit (`errorCode: provider_quota`) in the last 7 days, the tile says how many, with the next
  reset time when the error gave one and it is still ahead. No percentage of the quota is shown:
  the subscription's rolling windows are not exposed to `claude -p`.
- **Budgets** (Runs page): one banner per [monthly budget](agents.md#monthly-budgets) past its
  `warn_percent` (amber) or spent (coral when `hard_stop` refuses runs and has paused the
  scope's schedules; amber when it only warns). When the scope's runs this month are all
  subscription runs it is a "usage budget", and the banner says "usage of your subscription, at
  API value": same semantics, a brake on the quota shared with interactive use. Nothing shows
  while every budget is `ok`. A tick refused by a budget shows as "skipped, monthly budget spent"
  in the schedule's strip.
- **MCP**: the tool catalogue (`packages/mcp/dist/tools.json`, generated at build time from the
  real server; the published `@duskfleet/web` ships a copy as `tools.json`) with a sticky index
  and a filter by tool or parameter name (`/mcp?q=agent`), plus the registration snippets for
  Claude Desktop and Claude Code with your absolute paths (outside a checkout, the `duskfleet`
  package installed next to `@duskfleet/web`).
- **Settings** (the gear at the right end of the nav): the theme (Dark / Light / Device, the
  same choice as the footer switch, kept in this browser) and the runtime keys of
  `config/duskfleet.yaml`: concurrency limits, `scheduler.tick_seconds` and `auto_pause_after`,
  the Claude defaults (timeout, budget, `strict_mcp_config`, `setting_sources`, `binary`),
  `allowed_project_roots` and `default_agent`. Each section has its own Save, which lists the
  changes old → new in a confirmation first; a value the loader would refuse shows inline and
  blocks only its section. The save writes `config/duskfleet.yaml` itself, keeping its comments,
  and is checked by loading the config: a refused change restores the file. Every process
  re-reads the file on its next run or tick, except `claude.binary` and
  `claude.setting_sources`, marked "Restart MCP host". The scheduler kill switch
  (`scheduler.enabled`) sits in a Danger zone with its own confirmation, which names the active
  schedules and the next firing. The other keys (`data_dir`, `user_agents_dir`,
  `user_projects_file`, `scheduler.default_time_zone`, `noop_pattern`, `allow_command_gates`,
  `claude.allow_bypass_permissions`, `env_passthrough`) stay hand edits of the file. The header
  shows when the file last changed and whether that was a hand edit.

## Trends

`/trends` (the **Clean runs** card of the Runs page) shows how the share of clean runs moves
over time, on the agent / project filter the page was opened with (`?agent=`, `?project=`; the
"opened with" chips remove them; a Runs filter with several values in one dimension opens the
trend unscoped in that dimension). `?range=` picks the period:

| `range` | Period | One point per |
|---|---|---|
| `1m` (default) | 30 days | UTC day |
| `3m` | 13 weeks | ISO week (Monday to Sunday, UTC) |
| `6m` | 26 weeks | ISO week |
| `1y` | 12 months | UTC month |

Every bucket of the period is on the axis, with or without runs. Counts are finished real runs
(gate runs left out, running runs not yet counted) by their start time and their stored review
verdict, the same as the KPI cards:

- **Clean rate by agent**: clean / finished per bucket, one thin line per agent and a thick line
  for all of them. A bucket without finished runs is a gap. The agent whose rate fell the most
  (at least 5 points between its first and last point) is drawn in the accent colour, with a
  line naming its most frequent reason among its last 10 reviews. A series with fewer than 3
  points is drawn as dots. When the first run of the filter falls inside the period, the
  buckets before it are one flat band ("no runs before 7 Sep").
- **Finished runs per day / week / month**: stacked bars of clean, needs review and cancelled.
- **Why runs needed review**: one row per review reason with its count and its share of the
  runs that needed review in the period (a run can have several reasons); each row opens the
  Runs page on `?outcome=needs_review&reason=<id>` with the same filter.

With no finished run in the period, the page offers the 1-year view instead.

## Costs

`/costs` (the **Spent** card of the Runs page, or the "Spend by model moved to Costs" line under
the run list) shows where the money goes over time, on the agent / project filter the page was
opened with. `?range=` is the same period selector as `/trends`, same UTC buckets; `?by=agent`
(default), `project` or `model` picks the split. Runs count by their start time, as budgets do.

- **KPIs**: spend this UTC month (gates included) against the budget of the scope in view; the
  spend of the whole period with its average per bucket; the average cost of a real run this
  month; the budget's warning threshold and whether it hard-stops.
- **Spend per day / week / month**: stacked bars of the real runs' `cost_usd`, one segment per
  agent, project or model. The top spender of the period is in the accent colour, every other
  segment in the faint one (hover a segment for its name and amount). Totals sit above the bars
  (only the current one past 13 bars), the current bucket labelled "so far". Gate runs are never
  in the bars: their spend is one line under the chart ("on runs · on gates").
- **Budget overlay**: the monthly [budget](agents.md#monthly-budgets) as a dashed line and its
  `warn_percent` as a dotted one. Which budget: the global one when the page is unfiltered, the
  agent's (else the project's) when it is filtered; a filtered view never borrows the global
  budget. With weekly or daily bars the line is the budget pro rata (a month = 365 / 12 days),
  so it marks where a bucket overspends. No budget for the scope: no lines, and the `budgets set`
  command to create one.
- **By model**: finished runs of the period per model actually used (a run that mixed models
  counts under the one it asked for), with their average duration and cost, the total and the
  share of spend. It used to be on the Runs page.

## Remote access

The dashboard is localhost only and has **no authentication**. It shows prompts, transcripts,
diffs, local paths and cost, and its agents and schedules pages can delete agents and change
schedules. Both scripts bind to the loopback interface (`--hostname 127.0.0.1`), so another
machine on the network gets "connection refused". A middleware (`apps/web/middleware.ts`) also
answers `403` to any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` on
the dashboard's port (4777, or `PORT`): a web page cannot reach it through DNS rebinding.

To open it from another machine, tunnel the port over SSH instead of exposing it:

```bash
ssh -L 4777:127.0.0.1:4777 <host>    # then browse http://localhost:4777 on this machine
```

## Needs review

One rule decides what needs a human: `reviewReasons()` in core. `RunManager` applies it once,
when a run reaches its terminal status, and stores the result on the row
(`review_reasons_json`, migration 9; older rows are backfilled when the database is opened).
`list_runs` (`needsReview`, `reviewReasons`), the status badges, the KPI cards, the agent stats
(`NEEDS_REVIEW_SQL`, a test on that column) and the schedule rows all read that stored value, so
there is no second copy of the rule to keep in step. A run needs review when it ended before
the agent chose to stop, or when something silently narrowed what it could do:

| Reason | When |
|---|---|
| `budget_exhausted` | `terminationReason` says the budget ran out (with or without a wrap-up pass); fix: [troubleshooting](troubleshooting.md#budget-exhausted-or-timed-out) |
| `timed_out` | the agent's `timeout_minutes` elapsed; fix: [troubleshooting](troubleshooting.md#budget-exhausted-or-timed-out) |
| `orphaned` | Duskfleet restarted while the run was in progress; see [troubleshooting](troubleshooting.md#context-exhausted-and-orphaned-runs) |
| `nonzero_exit` | the process exited with a code other than 0 |
| `failed` | any other failure (spawn error, no result line) |
| `permission_denied` | a tool call was refused: the allow-list is incomplete; fix: [troubleshooting](troubleshooting.md#permission-denial) |
| `context_exhausted` | structured signal that the context window ran out; see [troubleshooting](troubleshooting.md#context-exhausted-and-orphaned-runs) |
| `mcp_missing` | an allow-listed MCP server never mounted; fix: [troubleshooting](troubleshooting.md#permission-denial) |
| `empty_run` | the run completed with zero tool calls ("no work done"; the same signal the schedule auto-pause counts as empty). Structured only: the result text is never read |

A run that used tools but never edited a file (a read-only reviewer, a planner) is not empty
and stays green. Rows finished before `empty_run` existed keep the reasons they were stored with.

A completed run with a reason is **needs review** (amber), never plain green; a failed or
timed-out run is red and its badge title names the reasons. `cancelled` is not a reason: a
person did it, whatever the main pass had left behind (a cancel during the wrap-up pass keeps
`budget_exhausted` on the row but yields no reason). Running runs have none yet. The Clean
runs card splits finished runs three ways: clean, completed but to review, failed. The run detail opens with a "Needs review" callout listing the reasons and
what they imply (a timeout or a budget stop without wrap-up may have left half-done,
unrecorded work). The Schedules page shows, next to the outcome of the last tick, how the
run it started **ended**: `started` alone looked fine on 2026-10-14 while the run behind it
had died out of budget, and nobody noticed for 11 hours.

The dashboard never mutates runs or builtins: the Claude Code child processes belong to the
MCP server process, so cancelling goes through `cancel_run` (Cowork) or the CLI. Its writes are
the actions on user agent files (delete, unlink), on schedule rows (pause / resume, edit
when, delete), all through the core API the MCP tools use, and the Settings page's edits of
`config/duskfleet.yaml` (core's `writeGlobalFile`).
