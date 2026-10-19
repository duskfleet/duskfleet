# DuskFleet

Orchestrate, observe and schedule autonomous **Claude Code** agents on your local projects.
No account, no cloud: a local MCP server, a SQLite database and a dashboard.

```
Claude Desktop / Claude Cowork / Claude Code
        │  MCP (stdio)
        ▼
  DuskFleet MCP server ──▶ Orchestration ──▶ Claude Code CLI ──▶ your local project
        │
        ▼
  SQLite (runs, events, schedules)  +  data/logs/<run_id>.jsonl
```

You describe *what should happen* in `config/` (agents, projects) and in schedules. DuskFleet
runs `claude -p` unattended with a target project as working directory, and records *what
happened*: every event, tool call, permission denial, token and dollar.

- **Agents** are Markdown files: a persona of your own, or a link to an agent the project
  already defines in `.claude/agents/`. DuskFleet owns only the unattended envelope
  (permissions, allow-lists, budget, MCP).
- **Runs** are started from a chat (MCP tools), from the CLI, or by a **cron schedule** that
  skips when the agent is busy and never queues.
- **The dashboard** shows every run with its cost, timeline and issues. A run that hit a
  permission denial is "needs review", never green.

> Formerly known as Gab Factory, renamed on 2026-10-11. An existing `data/gabfactory.db` is
> adopted automatically on first start.

## Requirements

- macOS or Linux, Node.js **24+** (built-in `node:sqlite`, no native addons)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and **logged in** for
  the user that will run DuskFleet. DuskFleet does not manage authentication.

## Quick start

```bash
git clone https://github.com/duskfleet/duskfleet.git
cd duskfleet
npm install
npm run build
npm run cli -- doctor          # Claude binary, version, where config and data live
```

Try a run on a small throwaway project of your own (anything with a failing test will do),
with the cheapest model:

```bash
npm run cli -- run --project /abs/path/to/scratch-project --model haiku -- "Fix the failing test"
npm run cli -- runs
npm run web                    # dashboard on http://localhost:4777
```

Then register the MCP server in Claude Desktop or Claude Code (the dashboard's **MCP** page
prints the snippet with your paths) and ask the assistant to create agents, start runs and
set up schedules. See [MCP server](docs/mcp-server.md).

Schedules fire only while a DuskFleet process runs. To keep them firing with Claude Desktop
closed, register the scheduler as a per-user service once (launchd, systemd `--user` or Task
Scheduler): `npm run cli -- install-service`. See [Schedules](docs/schedules.md#who-ticks).

Real runs cost money. An agent without an explicit `model` uses the Claude Code default; set
`haiku` or `sonnet` while experimenting.

## Documentation

| Page | Contents |
|---|---|
| [How it works](docs/how-it-works.md) | A run end to end, with diagrams: entry points, RunManager, the Claude Code child, what gets recorded, run lifecycle |
| [Configuration](docs/configuration.md) | `duskfleet.yaml`, projects registry, concurrency limits, environment variables |
| [Agents](docs/agents.md) | The two agent kinds (own, link), frontmatter, permission modes in unattended runs, project binding, MCP servers inside runs |
| [Schedules](docs/schedules.md) | Cron schedules, who ticks, running unattended as a service, busy and kill-switch policies |
| [MCP server](docs/mcp-server.md) | Registering in Claude Desktop and Claude Code, the tool catalogue, a typical conversation |
| [CLI](docs/cli.md) | Commands, and what a run records |
| [Dashboard](docs/dashboard.md) | The five views and what "needs review" means |
| [Development](docs/development.md) | Repository layout, code map, build and tests, security model, extending |
| [Troubleshooting](docs/troubleshooting.md) | Stuck runs, denials, orphaned runs, `doctor` failures |

## Status

Working today: agents, runs, scheduler, dashboard, 15 MCP tools. On the roadmap: deterministic
and LLM evals as post-run hooks, metrics, Git integration.

## License

[MIT](LICENSE)
