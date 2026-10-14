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
- **Schedules**: state, cron (human and raw), next tick (theoretical one for paused schedules),
  last outcome and firing history. Each row can be run now, paused / resumed, have its cron and
  time zone edited, or be deleted (inline confirmation); the changes go through the same
  validation as `update_schedule`. **Run now** does not start Claude from the dashboard: it marks
  the row and the process that holds the scheduler lease fires it on its next tick (within
  `tick_seconds`, paused or not, busy = skip), so it waits while no process ticks. The badge says which kind of process ticks (service, MCP host) and
  warns when only an MCP host does, with the `install-service` command. Creating a schedule and
  changing its agent, project, prompt or model stay on MCP (copyable `create_schedule` example).
- **MCP**: the tool catalogue (`packages/mcp/dist/tools.json`, generated at build time from the
  real server) with a sticky index, plus the registration snippets for Claude Desktop and
  Claude Code with your absolute paths.

A completed run that hit a permission denial or an allow-listed MCP server that never mounted
is **needs review** (amber), never plain green.

The dashboard never mutates runs or builtins: the Claude Code child processes belong to the
MCP server process, so cancelling goes through `cancel_run` (Cowork) or the CLI. Its writes are
the actions on user agent files (delete, unlink) and on schedule rows (pause / resume, edit
when, delete), all through the core API the MCP tools use.
