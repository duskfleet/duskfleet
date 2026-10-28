# Agents

An agent is a Markdown file with YAML frontmatter. The frontmatter is the unattended envelope
(model, permission mode, allow-lists, budget, MCP); the body, when present, is appended to
Claude Code's system prompt.

## Two kinds, chosen explicitly

| Kind | What it is | Required | Not allowed |
|---|---|---|---|
| **own** | A new agent whose persona lives in Duskfleet: the Markdown body is the system prompt | `system_prompt` (body) | `claude_agent` |
| **link** | A reference to an agent that a project **folder** already defines in `.claude/agents/<name>.md`. The run starts as `claude --agent <name>` in that folder: the project agent brings prompt, tools and model; Duskfleet adds only the unattended envelope (permissions, allow-list, budget, MCP, optional extra instructions) | `claude_agent` + the folder: `project_path` (absolute; registered as a project on the fly if new) or a registered `project` id. The target file is verified to exist | — |

`create_agent` makes you say which one (`kind: "own" | "link"`) and rejects inconsistent
combinations; `list_agents` reports `kind` for every agent and the dashboard shows
"link → name" or "own prompt". Rule of thumb: if the project already has a `.claude/agents/`
entry that does the job, link it; write a persona only when nothing exists.

## Where agent files live

| Where | Who writes it | Purpose |
|---|---|---|
| `config/agents/<id>.md` | you, in Git | **builtin** agents: where a checkout *may* keep agents it commits |
| `data/agents/<id>.md` (`user_agents_dir`) | `agents create` on the CLI, `create_agent` over MCP, or by hand | **user** agents, git-ignored. Same id as a builtin = override |

Duskfleet ships no starter or default agent (`default_agent: null`): your first agent is one you
create. From the CLI, `agents create` writes an own agent with safe defaults (a $0.50 budget,
`dontAsk`, file tools plus the common test commands, 10 minutes):

```bash
npm run cli -- agents create fixer --model haiku -- "You fix the failing test in this project. Run the tests, read the failure, change the minimum code, run them again. No git, no installs."
```

It goes through the same validate, write, reload and roll-back path as `create_agent` and refuses
an existing id unless `--force` ([CLI](cli.md#agents-create) lists the flags). Use `create_agent`
over MCP for a link agent.

Both are re-read on every run and every `list_agents` call, so edits apply without restarting
anything. Code never writes into `config/agents`. Because a user agent may later be committed,
`create_agent` / `update_agent` refuse home directory paths and secret-looking values in any
field, and store `add_dirs` inside your home directory as `~/...`
([MCP server](mcp-server.md)).

## Builtin agents

Two specialised patterns sit in this repository's `config/agents/`, not bound to any project.
They are not a starter agent and no run uses them unless you name them. Point them at a
project with `run_agent` or a schedule; to change their envelope (model, allow-list, budget),
copy the file into `data/agents/` with the same id and edit the copy.

| Id | What it does |
|---|---|
| `why-work-stopped` | Read-only diagnosis of work that stopped: repeated `skipped_busy`, needs-review runs, auto-paused schedules, daily caps, spent budgets, gate skips. It queries `duskfleet.db` with `sqlite3 -readonly -safe`: `-readonly` opens the file read-only and `-safe` blocks the dot-commands that run shell commands or write files, such as `.shell`, `.system`, `.output`. Neither blocks every SQL statement that writes elsewhere (`VACUUM INTO`, `ATTACH`), so "SELECT only" is a rule of its prompt, not a guarantee of the shell and greps `logs/<run id>.jsonl`, finds the pattern (the run holding the agent or project busy, the same denied tool every run, an orphan stuck as `running`), and ends with a verdict (`diagnosed:` / `healthy:` / `no data`), the evidence by run id, the cause and a numbered plan for a human. It proposes changes, never writes them. Sonnet, `dontAsk` with `Edit` / `Write` / `NotebookEdit` disallowed, `isolated: true` (it may run beside the agent it diagnoses), $1, 15 min. It needs the DuskFleet data directory in reach: run it on the DuskFleet checkout registered as a project (then `data/` is in its working directory), or on any project whose entry in `data/projects.yaml` has `add_dirs` pointing at the data directory (relative paths resolve from that file's folder, so `add_dirs: [.]` there is the data directory). Needs the `sqlite3` command-line shell on `PATH`, version 3.37 or later (the first with `-safe`) |
| `pr-check-loop` | Gets the checks of one pull request green. It takes the PR named in the task, or the oldest open PR whose head commit has a failing check (none: `nothing to do`). Each iteration reads the latest head SHA, waits for its checks (`gh pr checks --watch --interval 30`), classifies every failing job and applies a fixed action: **regression** = fix the code and push, **lint** = run the lint command locally and push, **flake** = one `gh run rerun --failed` per job, **external / secret** = stop with a blocker report. At most 5 iterations; it never force-pushes or touches workflow files, and stops on a dirty checkout. It leaves a PR comment unless the checks went green without any change from it. Sonnet, `acceptEdits`, $3, 60 min; the allow-list covers `gh pr` / `gh run`, `git` and `npm` (copy it into `data/agents/` for another toolchain). Meant to be scheduled every 30 minutes: `create_schedule` with cron `*/30 * * * *` on the project |

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
# max_concurrent: 3               # runs of this agent at once (whole number >= 1); default max_concurrent_per_agent (1)
# isolated: true                  # never edits the project checkout: ignores max_concurrent_per_project
# max_daily_runs: 24              # runs of this agent per UTC day (whole number >= 1); default no cap
# max_daily_cost_usd: 10          # spend of this agent per UTC day; default no cap
# env_passthrough: ["GH_TOKEN"]   # variables its runs get beyond the default allow-list (see "Environment of a run")
timeout_minutes: 30
max_budget_usd: 5
# wrap_up_reserve_usd: 0.5     # part of max_budget_usd kept for the wrap-up pass; default 10%, min $0.50, 0 = off
# on_failure: resume_once      # a schedule's next tick resumes a budget-exhausted / timed-out run, once (default none)
# resume_budget_usd: 3         # budget of that resumed run (default max_budget_usd)
---
You are running unattended. Finish the task end to end and summarise what you changed.
```

An agent without `model` uses the Claude Code default, which can be far more expensive than
`haiku` or `sonnet`. The dashboard warns when a model is not set.

## Budget reserve and wrap-up pass

A run that hits `max_budget_usd` is killed mid-action. On 2026-10-14 a scheduled run spent
its whole $5 on two subagents and died while writing the ticket comment that recorded its
work: the ticket stayed In Progress with no trace, and the agent's WIP limit then blocked the
next eleven hourly ticks. To make a budget stop leave a trace, Duskfleet splits the budget:

- the **main pass** is launched with `--max-budget-usd` = `max_budget_usd` − reserve;
- when it ends `budget_exhausted` (and only then), one **wrap-up pass** resumes the same
  session (`claude --resume <session>`) with `--max-budget-usd` = reserve and this prompt:

  > Your budget is exhausted. Do not start new work or call subagents. Record exactly where
  > you stopped and why, in the place your instructions say (ticket comment, PR comment, or
  > final message), then stop.

The reserve is `wrap_up_reserve_usd` when set, otherwise 10% of `max_budget_usd` with a
$0.50 floor; it is never more than half of the budget, and `0` disables the wrap-up pass.
`create_agent` / `update_agent` refuse an explicit reserve above half of the budget
(`max_budget_usd`, or `claude.default_max_budget_usd` when the agent sets none).
`list_agents` and the Agents page show the effective value.

The wrap-up pass is **not a separate run**. The run keeps one id and one session; its
`phases` list the two processes (`main`, `wrap_up`) with their own outcome, budget, cost,
turns and tool calls; cost, turns, tokens and tool calls are summed into the run; the
timeline carries `phase` events around the wrap-up's own tool calls; the run's `resultText`
is the wrap-up's final message (where it stopped), and the log file holds both passes with
a `#resume` marker between them. The run's **status is still `failed`** with
`terminationReason: budget_exhausted`: the task was not done. Only a wrap-up cancelled by
`cancel_run` turns the run `cancelled`; a `cancel_run` (or a shutdown) that arrives while the
main pass is already ending on its budget prevents the wrap-up pass. A wrap-up pass that exhausts the reserve too ends
there: there is never a third pass, and the run never spends more than `max_budget_usd`.
The wrap-up pass has at most ten minutes, and never more than what is left of the agent's
`timeout_minutes` (none left: no wrap-up pass), so the whole run never outlasts its timeout. If the
wrap-up process cannot be spawned, the run closes on the main pass with a note. It runs with the same permissions, tools and MCP servers as the main pass, so a ticket
comment it needs to write must already be allow-listed.

## Running an agent in parallel

By default an agent has one run at a time and a project directory has one run at a time
(`max_concurrent_per_agent`, `max_concurrent_per_project`, see
[Concurrency](configuration.md#concurrency)). That is right for agents that edit the checkout in
place, but wrong for a read-only reviewer or for an agent that works in its own git worktree.
Two frontmatter fields lift the limits per agent:

- `max_concurrent: <n>`: up to `n` runs of this agent may be active at once. The `n + 1`-th
  `run_agent` is refused with `agent busy: agent <id> already has n of n runs (...)`; a schedule
  of the agent fires while fewer than `n` runs are active and records `skipped_busy` otherwise.
- `isolated: true`: the agent never edits the project checkout. Its runs do not count against
  `max_concurrent_per_project` and are not blocked by it, so an isolated reviewer and a normal
  coder can work on the same project at the same time (two normal agents still cannot). This
  is a promise the agent's prompt keeps (read-only tools, or a worktree of its own); Duskfleet
  does not check it.

`max_concurrent_runs` stays the hard cap over everything. A non-integer or a value below 1
for `max_concurrent` is a config error naming the file. `list_agents` reports both fields
(`maxConcurrent` is the effective limit) and the dashboard shows them in the limits row when
they differ from the defaults.

## Daily caps

`max_concurrent` bounds how many runs are active at once; nothing in it bounds a day. An
hourly schedule, or a loop of `run_agent` calls, can start runs all day long. Two frontmatter
fields cap an agent per **UTC day** (from 00:00 UTC, whatever the schedule's time zone):

- `max_daily_runs: <n>`: every run of the agent created since 00:00 UTC counts, whatever its
  outcome (failed, cancelled, a gate run of this agent, a resume). The `n + 1`-th is refused.
- `max_daily_cost_usd: <x>`: once the recorded cost of the agent's runs since 00:00 UTC is at
  or above `x`, the next run is refused. A run in progress is not stopped and adds its cost only
  when it ends, so a day can end above `x` by at most one run's `max_budget_usd` per active run.

A refusal throws before anything is spawned or recorded, with a message starting
`daily cap: agent <id> ...`. It is not "busy": busy clears when a run ends, a cap only at the
next UTC midnight. A schedule of the agent records the tick as `skipped_daily_cap` (checked
after the busy check and before any gate, so a capped tick spends nothing; a capped gate agent
gives `skipped_daily_cap` too). A non-integer or a value below 1 for `max_daily_runs`, or a
non-positive `max_daily_cost_usd`, is a config error naming the file. `list_agents` reports
`maxDailyRuns` / `maxDailyCostUsd` (`null` = no cap); `update_agent` removes one with
`clear: ["max_daily_runs"]`.

## Monthly budgets

Daily caps bound one agent per day. A budget bounds a **scope** per **calendar month (UTC)**:
`global` (every run), `agent <id>` (the runs of one agent) or `project <id>` (the runs on one
project, whichever agent: counted by project id, and by the project's path for runs started
with a path). Budgets are rows in the database (`budgets` table), one per scope, managed with
`set_budget` / `list_budgets` / `delete_budget` over MCP or `duskfleet budgets` on the CLI:

```bash
npm run cli -- budgets set global --amount 200
npm run cli -- budgets set project my-app --amount 50 --warn 70
npm run cli -- budgets set agent pr-reviewer --amount 20 --no-hard-stop
npm run cli -- budgets
```

| Field | Meaning |
|---|---|
| `amount_usd` | spend allowed per UTC month, compared with the recorded `cost_usd` of the scope's runs created since the 1st at 00:00 UTC (gate runs included) |
| `warn_percent` | default 80: from this share of `amount_usd` the budget is `warn` |
| `hard_stop` | default true: once the spend reaches `amount_usd` (`over`), new runs in the scope are refused and its schedules paused. `false` = warn only, runs still start |

Every budget covering a run (global, the agent's, the project's) is checked in `startRun`,
after the busy guards and the daily caps, before anything is spawned. A spent hard-stop budget
throws a `BudgetError` (message `budget: the <scope> budget is spent ...`) and pauses every
enabled schedule of the scope (global: all of them; agent: that agent's; project: the schedules
that run on it, by their own `project_id` or their agent's binding). A schedule tick refused
this way is `skipped_budget`. Paused schedules stay paused when the month turns or the budget
is raised or deleted: resume them by hand. A run in progress is not stopped, so a month can end
above the amount by at most one run's `max_budget_usd` per active run.

The dashboard's **Runs** page shows a banner for each budget at `warn` (amber) or `over`
(coral when it stops runs); `list_budgets` and `duskfleet budgets` report `spentUsd`,
`percent`, `state` (`ok` \| `warn` \| `over`) and `periodStart` for every budget.

## Resume once on failure

The wrap-up pass leaves a trace; it does not finish the job. `on_failure: resume_once` lets a
**schedule** retry: on its next tick after a run of this agent ended `budget_exhausted` or
`timed_out`, it resumes that session (`claude --resume <session>`) instead of starting fresh,
with `resume_budget_usd` (default `max_budget_usd`; the wrap-up reserve applies to it too)
and a prompt that says the previous session ended early, to check what was already done
before redoing anything, and to finish and record the outcome. The retry is its own run,
linked both ways (`resumedFromRunId` on the retry, `resumedByRunId` in `get_run`, `list_runs`
and on the dashboard; `retries` counts the hop). It happens **once**: a retry that fails is
final and the tick after starts fresh; a retry that completes is followed by a fresh run as
usual. The default is `none`. A schedule can override the agent (`on_failure` on the
schedule, `none` to switch it off for that schedule); see [schedules](schedules.md#resume-once-on-failure).
`run_agent` is never retried: the policy belongs to the scheduler.

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
| `bypassPermissions` | Refused by Claude Code together with `--permission-prompts none`; Duskfleet rejects it with a clear error |

`permission_mode: acceptEdits` does not allow Bash: an agent that must run tests needs an
`allowed_tools` entry such as `Bash(npm test:*)`.

## Environment of a run

A run does not inherit the whole environment of the process running Duskfleet: only an
allow-list reaches it (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`,
`TERM`, `TZ`, `ANTHROPIC_*`, `CLAUDE_*`, `NODE_*`, `npm_config_*`, `XDG_*`, plus the Windows
basics; the full list is in [configuration](configuration.md#what-reaches-a-run)). A token such
as `GITHUB_TOKEN` or `NPM_TOKEN` in the shell that started the server is invisible to the agent
unless it is passed on by name:

```markdown
---
id: pr-fixer
allowed_tools: ["Bash(gh pr:*)"]
env_passthrough: ["GH_TOKEN"]     # exact names or PREFIX_*
---
```

`claude.env_passthrough` in `config/duskfleet.yaml` does the same for every agent; the two lists
are merged. `GH_TOKEN` is the one most agents need (for `gh`). Anything passed is readable by the
agent, so list only what it may use.

## Grouping agents by project

`project: <id>` on an agent binds it to an entry of `projects.yaml`. Bound agents are grouped
under their project in `list_agents` (`byProject`) and on the dashboard's Agents page, `run_agent`
targets that project when none is given, and a run on any other project is refused. Agents
without `project` are general-purpose and run wherever they are pointed. A `project` that is
not in `projects.yaml` is a config error, caught before the file is written when it comes
through `create_agent`.

## Reusing agents a project already defines

Projects often ship their own Claude Code agents in `.claude/agents/*.md` (persona, tools,
model). Instead of copying that prompt into Duskfleet, link to it:

```markdown
---
id: my-agent
claude_agent: my-agent     # <project>/.claude/agents/my-agent.md
project: my-app
permission_mode: acceptEdits
inherit_mcp: true
allowed_tools: ["mcp__claude_ai_Atlassian_Rovo", "Bash(yarn:*)", "Bash(git:*)", "Bash(gh pr:*)"]
---
Optional extra instructions, appended after the project agent's own prompt.
```

The run starts as `claude --agent my-agent`: the project agent decides who the
model is and what it does; the Duskfleet agent decides what it may do unattended
(permissions, allow-list, budget, MCP). `list_project_agents` shows what a project offers;
a link to a name the project does not define fails before anything is spawned. Note that a
project agent's `tools:` list does not grant permissions in unattended runs: those tools
still need to be in `allowed_tools` here.

Two things to get right with a link:

- **Prompt it as the agent, not as its caller.** The run *is* the project agent. If the
  project also ships a command that invokes that agent (a gate such as
  `/pickup-task` that checks an issue tracker and then calls `my-agent`), do not tell the
  link to run that command: the agent would invoke itself as a subagent, paying two Opus
  hops for one unit of work. Prompt it with "find your own work and run your loop". Keep
  the command for an `own` agent on a cheap model if you want the gate before the hop.
- **MCP tool names in the project agent's `tools:` must be the ones unattended runs see**
  (`mcp__claude_ai_Atlassian_Rovo__*`, `mcp__claude_ai_Figma__*`), not the `mcp__plugin_*`
  names interactive sessions show. The list is an allow-list: with the wrong prefix the
  agent is denied the tools that exist. Listing both prefixes keeps the file usable from
  both.

A worked example of links and own agents together: [How Duskfleet builds itself](self-hosting-development.md)
describes the agents that develop this repository, with sanitised copies of their files.

## MCP servers inside runs

By default a run starts with `--strict-mcp-config`: no MCP server at all, 25 built-in tools,
no way to recurse into Duskfleet. Set `inherit_mcp: true` on an **agent** or on a
**project** and the run instead sees the MCP servers of the user running Duskfleet,
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
**needs review** and adds a note event, instead of failing silently. The check only runs
when Claude Code listed the mounted servers at init: with claude.ai connectors loaded as
deferred tools that list is empty (Claude Code 2.1.306), and a server that was allow-listed
but not called in that run is not reported, since a call on one server says nothing about
another.

**Connectors load at start or not at all.** Now and then Claude Code comes up with no
claude.ai connector (3 runs out of 12 on 2026-10-20: the init line listed only the project's
`.mcp.json` server). With `inherit_mcp`, Duskfleet compares the init line against the agent's
allow-listed servers and, when the list names other servers but not that one, ends the process
and starts it again with a fresh
session, once; the init line comes before the first model turn, so the restart costs seconds,
not dollars. The run gets a note (`init reported no server for mcp__claude_ai_Figma ...
restarted once`) and the log a `#restart` marker. If the second process lacks it too, the run
goes on and is flagged `mcp_missing` as above. Entries that never mount because the name is
wrong (`mcp__plugin_*`) trigger the same one restart on every run: fix the name. An empty
list (connectors loaded as deferred tools) is no evidence either way and never restarts.

## Subagents inside runs

A project agent usually delegates: a coordinator spawns a designer, a reviewer, a tester
through Claude Code's `Agent` tool. Duskfleet records every such invocation as its own row
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

`get_run` and the CLI `run-info` both return them as `subagents`, each with `type`, `brief` and
`report` (stored as `subagentType`, `prompt` and `resultText`; only the plain-language names are
sent, on both surfaces). The
report is stored as the subagent wrote it: Claude Code's hand-back frame (provenance preamble,
two-space indent, `agentId` / `<usage>` footer) is stripped; without the preamble, a trailing
`<usage>` block is stripped only after an `agentId:` line, so a report that ends with one of its
own stays whole. A hand-back closes the subagent only with a final status: a failed one wins
over an earlier completed, and a background `Agent` call (`async_launched`) stays open until
its `task_notification`. When a stream lacks the
`task_started` or nested lines, the hand-back's `tool_use_result` (`agentType`, `prompt`,
`resolvedModel`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`) and the parent's
`Agent` call input still fill the row; the harness totals win over counted figures, and a
subagent seen only through its hand-back starts at `endedAt - totalDurationMs` (or at the
`Agent` call's stream time). Rows recorded by an older parser (missing any of these, still
holding a raw frame, or left `running` by a process that died) are backfilled with
`duskfleet repair-subagents`: it replays each finished run's `data/logs/<run_id>.jsonl` with
the current parser, takes status and end time from the log when the log closed an open
subagent (a failed outcome also replaces a stored completed; a stored failed or interrupted is
never downgraded), takes a duration only when the log measured it (harness total or two stream
timestamps, never the replay's clock), marks rows the log left open `interrupted` (rows of a
run with no readable log are left alone), and writes a row only when that changes it and
nobody wrote it since it was read. Reads never write.
Tool-use
events in the timeline carry the `agentId` they belong to (null for the main session).
Nothing is spawned differently: the data comes from the `task_started` /
`task_notification` lines and the `agent_id` field of nested messages in Claude Code's
stream, so it works for `own` and `link` agents alike. Remember that a subagent's own
`tools:` list is a hard filter: a name that does not exist in the run (for instance a
`mcp__plugin_*` prefix) leaves it without that tool, and only the recorded row shows it.
