# Dashboard

```bash
npm run web            # dev server on http://localhost:4777
# or: npm run build:web && npm run start -w @duskfleet/web
```

A Next.js app that reads the database the MCP server writes (SQLite WAL mode). It can run
while the MCP server is running or not; it only needs `config/` and `data/duskfleet.db`. It
has no authentication: keep it on localhost.

Five views. The runs list and a running run's detail auto-refresh every 3 seconds (pause button
in the nav); the other pages are static.

- **Runs**: KPI cards (clean runs, needs review, spend) computed on the current filter; project /
  agent chips, prompt search (`?q=`), `?schedule=` and `?limit=` (load older). Runs are identified
  by a short title (first line of the prompt); the whole row links to the detail.
- **Run detail**: short title, status line, duration / cost / turns / tool calls / tokens, the
  issues (denied calls highlighted in the timeline, missing MCP servers, context exhaustion),
  the linked retry when the run resumed an earlier one or was resumed by a later one
  (`on_failure: resume_once`; the list shows "resumes ↗" / "retried ↗" flags),
  final message (long results collapse), a callout when a budget exhaustion was followed by a
  wrap-up pass (what the main pass spent, what the wrap-up cost and whether it recorded where
  it stopped; the wrap-up's own tool calls sit between `wrap-up started` / `wrap-up ended`
  rows of the timeline), event timeline with legend and grouped repeats,
  previous / next run of the same agent, a "run again" CLI command, the `claude --resume`
  command and the exact command executed. Home paths print as `~/…`; Copy buttons give the
  full value.
- **Agents**: every agent grouped by project ("Any project" first) with kind ("link → name" or
  "own prompt"), model (with a warning when not set), permission mode, allow-lists (collapsed
  past 4 entries), limits (timeout, budget and the wrap-up reserve), prompt preview and
  aggregate stats. User agents can be deleted or
  unlinked from here, with an inline confirmation; builtins are read-only.
- **Schedules**: a status strip (kill switch, lease holder and when its lease expires, next
  firing, last 7 days fired / skipped busy), then the schedules grouped by project (the
  schedule's own, else its agent's; "no project" last), one card each: cron (raw and in plain words), agent, model, the
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
- **Spent** (Runs page) splits into "on runs" and "on gates" once a gate agent has run; gate
  runs carry a `gate` flag in the run list and are left out of the run counts (total, clean,
  failed, needs review): a gate is a yes/no check, not work.
- **MCP**: the tool catalogue (`packages/mcp/dist/tools.json`, generated at build time from the
  real server) with a sticky index, plus the registration snippets for Claude Desktop and
  Claude Code with your absolute paths.

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
| `budget_exhausted` | `terminationReason` says the budget ran out (with or without a wrap-up pass) |
| `timed_out` | the agent's `timeout_minutes` elapsed |
| `orphaned` | DuskFleet restarted while the run was in progress |
| `nonzero_exit` | the process exited with a code other than 0 |
| `failed` | any other failure (spawn error, no result line) |
| `permission_denied` | a tool call was refused: the allow-list is incomplete |
| `context_exhausted` | structured signal that the context window ran out |
| `mcp_missing` | an allow-listed MCP server never mounted |

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
the actions on user agent files (delete, unlink) and on schedule rows (pause / resume, edit
when, delete), all through the core API the MCP tools use.
