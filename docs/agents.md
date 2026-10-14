# Agents

An agent is a Markdown file with YAML frontmatter. The frontmatter is the unattended envelope
(model, permission mode, allow-lists, budget, MCP); the body, when present, is appended to
Claude Code's system prompt.

## Two kinds, chosen explicitly

| Kind | What it is | Required | Not allowed |
|---|---|---|---|
| **own** | A new agent whose persona lives in DuskFleet: the Markdown body is the system prompt | `system_prompt` (body) | `claude_agent` |
| **link** | A reference to an agent that a project **folder** already defines in `.claude/agents/<name>.md`. The run starts as `claude --agent <name>` in that folder: the project agent brings prompt, tools and model; DuskFleet adds only the unattended envelope (permissions, allow-list, budget, MCP, optional extra instructions) | `claude_agent` + the folder: `project_path` (absolute; registered as a project on the fly if new) or a registered `project` id. The target file is verified to exist | — |

`create_agent` makes you say which one (`kind: "own" | "link"`) and rejects inconsistent
combinations; `list_agents` reports `kind` for every agent and the dashboard shows
"link → name" or "own prompt". Rule of thumb: if the project already has a `.claude/agents/`
entry that does the job, link it; write a persona only when nothing exists.

## Where agent files live

| Where | Who writes it | Purpose |
|---|---|---|
| `config/agents/<id>.md` | you, in Git | **builtin** agents committed with the repo |
| `data/agents/<id>.md` (`user_agents_dir`) | `create_agent` over MCP, or by hand | **user** agents, git-ignored. Same id as a builtin = override |

Both are re-read on every run and every `list_agents` call, so edits apply without restarting
anything. Code never writes into `config/agents`.

## Frontmatter

```markdown
---
id: my-coder
name: My coder
description: Implements the task it is given.
# model: sonnet
permission_mode: acceptEdits      # acceptEdits | dontAsk | auto | manual  (plan and bypassPermissions: see below)
# allowed_tools: ["Bash(npm test:*)", "mcp__claude_ai_Atlassian_Rovo"]
# disallowed_tools: ["Edit", "Write", "NotebookEdit"]   # read-only agent
# project: my-app                 # bind to a project: grouped under it, default target, refused elsewhere
# inherit_mcp: true               # see "MCP servers inside runs"
# add_dirs: ["~/Documents/Projects/other-repo"]        # --add-dir; runs are confined to the project otherwise
# effort: high
timeout_minutes: 30
max_budget_usd: 5
# wrap_up_reserve_usd: 0.5     # part of max_budget_usd kept for the wrap-up pass; default 10%, min $0.50, 0 = off
---
You are running unattended. Finish the task end to end and summarise what you changed.
```

An agent without `model` uses the Claude Code default, which can be far more expensive than
`haiku` or `sonnet`. The dashboard warns when a model is not set.

## Budget reserve and wrap-up pass

A run that hits `max_budget_usd` is killed mid-action. On 2026-10-14 a scheduled run spent
its whole $5 on two subagents and died while writing the ticket comment that recorded its
work: the ticket stayed In Progress with no trace, and the agent's WIP limit then blocked the
next eleven hourly ticks. To make a budget stop leave a trace, DuskFleet splits the budget:

- the **main pass** is launched with `--max-budget-usd` = `max_budget_usd` − reserve;
- when it ends `budget_exhausted` (and only then), one **wrap-up pass** resumes the same
  session (`claude --resume <session>`) with `--max-budget-usd` = reserve and this prompt:

  > Your budget is exhausted. Do not start new work or call subagents. Record exactly where
  > you stopped and why, in the place your instructions say (ticket comment, PR comment, or
  > final message), then stop.

The reserve is `wrap_up_reserve_usd` when set, otherwise 10% of `max_budget_usd` with a
$0.50 floor; it is never more than half of the budget, and `0` disables the wrap-up pass.
`list_agents` and the Agents page show the effective value.

The wrap-up pass is **not a separate run**. The run keeps one id and one session; its
`phases` list the two processes (`main`, `wrap_up`) with their own outcome, budget, cost,
turns and tool calls; cost, turns, tokens and tool calls are summed into the run; the
timeline carries `phase` events around the wrap-up's own tool calls; the run's `resultText`
is the wrap-up's final message (where it stopped), and the log file holds both passes with
a `#resume` marker between them. The run's **status is still `failed`** with
`terminationReason: budget_exhausted`: the task was not done. Only a wrap-up cancelled by
`cancel_run` turns the run `cancelled`. A wrap-up pass that exhausts the reserve too ends
there: there is never a third pass, and the run never spends more than `max_budget_usd`.
The wrap-up pass has at most ten minutes (less when the agent's `timeout_minutes` is shorter)
and runs with the same permissions, tools and MCP servers as the main pass, so a ticket
comment it needs to write must already be allow-listed.

## Permissions in unattended runs

Permission modes map 1:1 to `claude --permission-mode`. Runs always add
`--permission-prompts none`: nobody can answer a prompt, so anything not covered by
`allowed_tools` is denied and recorded on the run as `deniedTools` (one entry per refused
call, with the command or file) and `permissionDenials`. A run with denials shows as
**needs review** in the dashboard: it means the allow-list is incomplete, not that a human
stepped in. `--permission-prompts none` also ignores the project's own `.claude/settings`
allow-lists and confines file tools to the project directory (`add_dirs` widens that).

Verified against Claude Code 2.1.295 on 2026-10-08 with real runs:

| Mode | Unattended behaviour |
|---|---|
| `acceptEdits` | Edits in the project allowed; Bash and MCP only if allow-listed |
| `dontAsk` | Same, nothing prompts. **Use this for read-only agents** together with `disallowed_tools: [Edit, Write, NotebookEdit]`, which removes those tools from the session |
| `plan` | Blocks Bash, MCP and file writes entirely, allow-list or not. Useless for unattended work |
| `bypassPermissions` | Refused by Claude Code together with `--permission-prompts none`; DuskFleet rejects it with a clear error |

`permission_mode: acceptEdits` does not allow Bash: an agent that must run tests needs an
`allowed_tools` entry such as `Bash(npm test:*)`.

## Grouping agents by project

`project: <id>` on an agent binds it to an entry of `projects.yaml`. Bound agents are grouped
under their project in `list_agents` (`byProject`) and on the dashboard's Agents page, `run_agent`
targets that project when none is given, and a run on any other project is refused. Agents
without `project` are general-purpose and run wherever they are pointed. A `project` that is
not in `projects.yaml` is a config error, caught before the file is written when it comes
through `create_agent`.

## Reusing agents a project already defines

Projects often ship their own Claude Code agents in `.claude/agents/*.md` (persona, tools,
model). Instead of copying that prompt into DuskFleet, link to it:

```markdown
---
id: app-coordinator
claude_agent: app-coordinator     # <project>/.claude/agents/app-coordinator.md
project: my-app
permission_mode: acceptEdits
inherit_mcp: true
allowed_tools: ["mcp__claude_ai_Atlassian_Rovo", "Bash(yarn:*)", "Bash(git:*)", "Bash(gh pr:*)"]
---
Optional extra instructions, appended after the project agent's own prompt.
```

The run starts as `claude --agent app-coordinator`: the project agent decides who the
model is and what it does; the DuskFleet agent decides what it may do unattended
(permissions, allow-list, budget, MCP). `list_project_agents` shows what a project offers;
a link to a name the project does not define fails before anything is spawned. Note that a
project agent's `tools:` list does not grant permissions in unattended runs: those tools
still need to be in `allowed_tools` here.

## MCP servers inside runs

By default a run starts with `--strict-mcp-config`: no MCP server at all, 25 built-in tools,
no way to recurse into DuskFleet. Set `inherit_mcp: true` on an **agent** or on a
**project** and the run instead sees the MCP servers of the user running DuskFleet,
including the claude.ai connectors (Atlassian, Figma, Gmail, Drive, ...). Verified: 168 tools,
140 of them from connectors. Each server still has to be allow-listed on the agent, by
server (`mcp__claude_ai_Atlassian_Rovo`) or by tool (`mcp__claude_ai_Figma__get_screenshot`).
No `--mcp-config` file is involved: connectors are account-level and already authenticated.

**Names differ by how a server is registered.** The same Atlassian service is
`mcp__plugin_productivity_atlassian__*` when it comes from a Claude Code plugin (user
settings, not loaded in runs) and `mcp__claude_ai_Atlassian_Rovo__*` as a claude.ai
connector (what runs see). Every run records what was mounted and which servers were
actually called (`get_run` → `mcp`, dashboard → Technical details). An allow-list entry
whose server never mounted is reported as `mcp.allowListedMissing`, flags the run as
**needs review** and adds a note event, instead of failing silently.

## Subagents inside runs

A project agent usually delegates: a coordinator spawns a designer, a reviewer, a tester
through Claude Code's `Agent` tool. DuskFleet records every such invocation as its own row
(`run_agents`, migration 5), so the unit you can judge is not only the run but each agent
that did part of the work:

- `subagentType` (the `.claude/agents/<name>.md` it ran as, or a builtin such as `claude`),
  `description`, the **brief** the parent gave (`prompt`) and the **report** it handed back
  (`resultText`);
- `status` (`completed`, `failed`, or `interrupted` when the run ended first), `model`,
  timings, `toolCalls` and the distinct `tools` it used, token figures (`totalTokens` is the
  reliable one), `parentAgentId` for nested delegation;
- `definitionHash`: a short hash of the project agent file at start time, so evals can tell
  which version of a persona produced a result.

`get_run` returns them as `subagents`; `run-info` on the CLI does the same. Tool-use
events in the timeline carry the `agentId` they belong to (null for the main session).
Nothing is spawned differently: the data comes from the `task_started` /
`task_notification` lines and the `agent_id` field of nested messages in Claude Code's
stream, so it works for `own` and `link` agents alike. Remember that a subagent's own
`tools:` list is a hard filter: a name that does not exist in the run (for instance a
`mcp__plugin_*` prefix) leaves it without that tool, and only the recorded row shows it.
