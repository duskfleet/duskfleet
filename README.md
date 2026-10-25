<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
  <img alt="Duskfleet" src="docs/assets/logo-light.svg" width="400">
</picture>

# Duskfleet

### Run, record and schedule unattended Claude Code agents on your local projects.

**A fleet of agents for your own machine.**

Website: [duskfleet.com](https://duskfleet.com/?utm_source=github&utm_medium=readme&utm_campaign=always-on&utm_content=hero)

[![CI](https://github.com/duskfleet/duskfleet/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/duskfleet/duskfleet/actions/workflows/ci.yml)
[![Node 24+](https://img.shields.io/badge/node-24%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-F0783A)](LICENSE)
[![MCP tools: 15](https://img.shields.io/badge/MCP%20tools-15-E24B5A)](docs/mcp-server.md)

[Quick start](#quick-start) ·
[How it works](#how-it-works) ·
[What you get](#what-you-get) ·
[Status and roadmap](#status-and-roadmap) ·
[Documentation](#documentation) ·
[License](#license) ·
[Website](https://duskfleet.com/?utm_source=github&utm_medium=readme&utm_campaign=always-on&utm_content=readme)

</div>

**Who it is for:** people who already run Claude Code on their own projects and want those runs
unattended, scheduled and recorded, on their own machine. Duskfleet runs `claude -p` against a
project on your disk and keeps a record of what happened.

- **Local, no account, no cloud**: everything runs on your machine with your own Claude Code
  login; there is no service in between.
- **Every run recorded**: events, tool calls, permission denials, tokens and cost land in a
  local SQLite database, plus a JSONL log per run.
- **Cron schedules and a dashboard**: schedules fire from a local process, and a dashboard on
  localhost shows runs, schedules and agents.

## Quick start

Requirements: macOS or Linux, Node.js **24+** (built-in `node:sqlite`, no native addons; `.nvmrc`
pins it, and an older Node gets `Duskfleet needs Node 24 or newer; you have vX.Y.Z`), and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and **logged in** for
the user that runs Duskfleet (Duskfleet does not manage authentication).

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

> [!WARNING]
> Real runs cost money. An agent without an explicit `model` uses the Claude Code default; set
> `haiku` or `sonnet` while experimenting.

Then register the MCP server in Claude Desktop or Claude Code (the dashboard's **MCP** page
prints the snippet with your paths) and ask the assistant to create agents, start runs and set
up schedules: see [MCP server](docs/mcp-server.md). To keep schedules firing with Claude
Desktop closed, register the scheduler as a per-user service once with
`npm run cli -- install-service` ([Schedules](docs/schedules.md#who-ticks)).

## How it works

```
Claude Desktop / Claude Cowork / Claude Code
        │  MCP (stdio)
        ▼
  Duskfleet MCP server ──▶ Orchestration ──▶ Claude Code CLI ──▶ your local project
        │
        ▼
  SQLite (runs, events, schedules)  +  data/logs/<run_id>.jsonl
```

You describe *what should happen* in `config/` (agents, projects) and in schedules. Duskfleet
runs `claude -p` unattended with a target project as working directory, owns the unattended
envelope (permissions, allow-lists, budget, MCP) and records *what happened*. A run end to end,
with diagrams: [How it works](docs/how-it-works.md).

## What you get

| | |
|---|---|
| **Agents** | Markdown files: a persona of your own, or a link to an agent the project already defines in `.claude/agents/`. [Agents](docs/agents.md) |
| **Runs** | Every event, tool call, permission denial, token and dollar, in SQLite and a JSONL log per run. [CLI](docs/cli.md) |
| **Schedules** | Cron schedules that skip when the agent is busy, never queue and never catch up. [Schedules](docs/schedules.md) |
| **Dashboard** | Runs with cost, timeline and issues; a run that hit a permission denial is "needs review", never green. [Dashboard](docs/dashboard.md) |
| **MCP tools** | 19 tools to create agents, start and inspect runs and manage schedules from a chat. [MCP server](docs/mcp-server.md) |
| **CLI** | The same operations from a terminal, plus `serve` and `install-service` for the scheduler. [CLI](docs/cli.md) |

## Status and roadmap

Working today: agents, runs, scheduler, dashboard, 19 MCP tools. On the roadmap: deterministic
and LLM evals as post-run hooks, metrics, Git integration.

Formerly Gab Factory (renamed 2026-10-11); an existing `data/gabfactory.db` is adopted on first
start.

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

## License

[MIT](LICENSE)
