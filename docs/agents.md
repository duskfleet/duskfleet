# Agents

An agent is a Markdown file with YAML frontmatter. The frontmatter is the unattended envelope
(model, permission mode, allow-lists, budget, MCP); the body, when present, is appended to
Claude Code's system prompt.

## Two kinds, chosen explicitly

| Kind | What it is | Required | Not allowed |
|---|---|---|---|
| **own** | A new agent whose persona lives in Duskfleet: the Markdown body is the system prompt | `system_prompt` (body) | `project_agent` |
| **link** | A reference to an agent that a project **folder** already defines for the agent's harness (claude: `.claude/agents/<name>.md`, copilot: `.github/agents/<name>.agent.md`, see [the table below](#project-agents-per-harness)). The run starts as `claude --agent <name>` / `copilot --agent <name>` in that folder: the project agent brings prompt, tools and model; Duskfleet adds only the unattended envelope (permissions, allow-list, budget, MCP, optional extra instructions on `claude`) | `project_agent` (older name `claude_agent`, same field: set one, never both) + the folder: `project_path` (absolute; registered as a project on the fly if new) or a registered `project` id. The target file is verified to exist | — |

`create_agent` makes you say which one (`kind: "own" | "link"`) and rejects inconsistent
combinations; `list_agents` reports `kind` for every agent and the dashboard shows
"link → name" or "own prompt". Rule of thumb, per harness: settle the agent's harness first. On
`claude` or `copilot`, if the project already has an entry in that harness's folder that does the
job, link it; write a persona only when nothing exists. On a harness that cannot run a link yet
(`codex` today), the agent is `own`: the persona goes in `system_prompt`, even when the project
defines agents in that harness's folder.

`project_agent:` is the field's name whatever the harness; `claude_agent:` is its older name and
stays accepted. Both load into the same definition, so an existing agent file keeps its
`agent_hash` and its continued sessions; a file or a create / update that sets both is refused.
Files written by `create_agent` / `update_agent` keep the `claude_agent:` key.

### Project agents per harness

Each harness has one folder of project agents, and it is the only place guidance, errors and
docs name for that harness. Whether a link can run there is a separate capability
(`projectAgents`, [Harnesses](harnesses.md)):

| Harness | Folder in the project repository | Link (`project_agent`) |
|---|---|---|
| `claude` | `.claude/agents/<name>.md` | yes, `claude --agent <name>` |
| `copilot` | `.github/agents/<name>.agent.md` | yes, `copilot --agent <name>`, without a body ([Copilot links](#copilot-links)) |
| `codex` | `.codex/agents/<file>.toml` (the `name` field identifies the agent, not the file name) | not yet: `own` only |

`list_project_agents { harness }` reads that harness's folder only (default `claude`) and says
whether the result is `linkable`. A link on a harness without links is refused (create, update,
`agents create` and run start, one message from core) with the way forward: `kind: "own"` on
that harness, or `harness: claude` if the project really defines a Claude Code agent. Duskfleet
never writes agent files into a project.

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

These files hold each agent's unattended envelope (permissions, allow-list, budget, sandbox,
environment) and live outside every project on purpose, so a run cannot widen its own permissions:
see [where the unattended envelope lives](security.md#where-the-unattended-envelope-lives).

### A file that does not load

An agent file you edit by hand can break: invalid frontmatter, an id another file in the same
directory already has, or a `project:` that is not in `projects.yaml`. Duskfleet skips that one
file and loads everything else, so the other agents keep running and their schedules keep firing.

- Its id is unavailable until the file is fixed. A broken file in `data/agents/` never falls back
  to the builtin of the same id: a run, a schedule or a gate of that agent fails with an error that
  names the file. With two files of the same id in one directory, the first one (by file name)
  loads and the second is skipped.
- When the YAML cannot be parsed at all, the id is a guess: the first `id:` line of the
  frontmatter, else the file name.
- `create_agent` and `agents create` refuse that id unless you pass `overwrite: true` (CLI:
  `--force`), naming the file and its error. `update_agent` refuses it too: fix the file by hand,
  replace it, or remove it with `delete_agent` or the dashboard's delete, which delete the broken
  user file whatever its name.
- A file belongs to the id it declares, not to its name. `create_agent`, `update_agent` and
  `agents create` write `data/agents/<id>.md`, so when that file holds another agent (say
  `helper.md` declaring `id: code-helper`) they refuse, even with `overwrite: true` / `--force`:
  rename that file to its own id, or choose another one.
- `list_agents` (`skippedAgents`), `duskfleet agents` (after the table; with `--json` on stderr,
  stdout stays the list) and `duskfleet doctor` (one warning line per file, `skippedAgents` in
  `--json`) name the file and its error.
- `default_agent` naming a skipped agent does not stop the load either: a run without an agent
  fails with the file's error.

`duskfleet.yaml` and the two `projects.yaml` files are different: an error there still fails the
load, and a running process keeps its last good config until it is fixed.

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
# skills: [review-checklist]      # Duskfleet skills in data/skills/ or config/skills/ (see "Skills")
# sandbox: true                   # Bash inside Claude Code's sandbox: no writes outside the project and add_dirs (see "Sandbox")
# sandbox_allowed_domains: [github.com, api.github.com, registry.npmjs.org]   # hosts a sandboxed run may reach; default none
# sandbox_weaker_network_isolation: true   # macOS: lets gh verify TLS inside the sandbox; weaker isolation (see "Sandbox")
timeout_minutes: 30               # at most 35791 (about 24.8 days, the longest timer Node holds); more is refused
max_budget_usd: 5
# wrap_up_reserve_usd: 0.5     # part of max_budget_usd kept for the wrap-up pass; default 10%, min $0.50, 0 = off
# on_failure: resume_once      # a schedule's next tick resumes a budget-exhausted / timed-out run, once (default none)
# resume_budget_usd: 3         # budget of that resumed run (default max_budget_usd)
# harness: claude              # the agent CLI that runs it: claude (default), copilot, codex or cursor (see "Harness")
# codex_network: true          # harness codex + acceptEdits only: network on, every host, your credentials (see "Codex agents")
---
You are running unattended. Finish the task end to end and summarise what you changed.
```

An agent without `model` uses the Claude Code default, which can be far more expensive than
`haiku` or `sonnet`. The dashboard warns when a model is not set.

## Harness

`harness:` names the agent CLI that runs the agent. Leave it out: `claude` (Claude Code) is the
default. `copilot` runs it with GitHub Copilot CLI (see [Copilot agents](#copilot-agents)), `codex`
with Codex CLI (see [Codex agents](#codex-agents)), `cursor` with Cursor Agent CLI (see
[Cursor agents](#cursor-agents)). Each
CLI is one adapter behind the same run path; see [Harnesses](harnesses.md).

Each harness declares what it can honour (its *capabilities*). An agent that sets a field its
harness cannot honour is **refused**, at create / update and again when a run starts, with the
field named (`allowed_tools is not supported by harness codex`). A field is never dropped
silently and never approximated: an allow-list a CLI ignored would be a permission nobody granted.

| Capability | Fields it covers |
|---|---|
| `toolAllowList` | `allowed_tools`, `disallowed_tools` |
| `permissionModes` | the `permission_mode` values the harness accepts |
| `resumeSession` | `on_failure: resume_once`, `resume_budget_usd`; a continued run starts a fresh session (with a note) without it |
| `hardBudgetUsd` | `max_budget_usd`, `wrap_up_reserve_usd`, `resume_budget_usd`, a gate's `budget_usd`, a resume budget (the CLI stops itself at the budget) |
| `reportsCostUsd` | `max_daily_cost_usd`; without it every run is `unpriced` and [budgets](#unknown-costs-fail-closed) count it as its cap |
| `mcpInherit` | `inherit_mcp` (agent or project) |
| `projectAgents` | `claude_agent` (link agents) |
| `addDirs` | `add_dirs` (agent or project) |
| `skills`, `effort`, `sandbox` | the fields of the same name (`sandbox_*` with `sandbox`) |
| `subagents` | informational: nested agents are reported as rows |

Claude Code has every capability, so a Claude agent runs exactly as before the field existed. The
run records its harness (`harness` in `get_run` / `run-info --json`, a line on the run page).
It also records the effort it was started with (`effort` in `get_run`, `list_runs` and `run-info`):
the value passed to the CLI, null when none was (the CLI's default). That is the agent's `effort:`,
unless the run overrides it: `run_agent { effort }`, `run --effort`, a schedule's `effort` or a
gate's `gate.agent.effort` (one of the same five levels; refused on a harness without `effort`,
never dropped). `agents create --effort <level>` writes the field. A resume (`on_failure:
resume_once`) keeps the effort of the run it resumes.

### Copilot agents

`harness: copilot` runs the agent with GitHub Copilot CLI, under the user's GitHub login. It is
available when Duskfleet finds the binary (`copilot.binary` in `duskfleet.yaml`, else `copilot` on
PATH; `doctor` says `copilot not installed` otherwise). Only `own` agents: `link` agents stay
Claude-only.

```markdown
---
description: Tidies the changelog
harness: copilot
model: claude-haiku-4.5
permission_mode: dontAsk
allowed_tools: ["shell(git)", "write(CHANGELOG.md)"]
timeout_minutes: 15
---
Keep CHANGELOG.md in order. Never touch other files.
```

- **Tool rules are Copilot's own**, passed verbatim to `--allow-tool` / `--deny-tool`: `shell`,
  `shell(<command>)`, `write`, `write(<path>)`, `read`, `read(<path>)`, `url(<domain>)`, `memory`.
  A Claude rule (`Bash(git:*)`, `Read`, `Edit`, `mcp__*`) is refused with the entry named, never
  translated: Copilot matches a shell command by its first subcommand only, so `shell(gh pr)` allows
  `gh pr merge` too. Write the narrowest rule Copilot can express and know that is its granularity.
- **Two modes.** `dontAsk`: only the rules (a non-interactive Copilot run denies anything that
  would prompt). `acceptEdits` (the default): the rules plus `write`. Every other mode is refused.
- **The body is the persona** of an own agent: written to a per-run agent file and loaded with
  `--agent`. The project's own `AGENTS.md` is loaded too, as `CLAUDE.md` is for Claude.
- **Refused**: `max_budget_usd`, `wrap_up_reserve_usd`, `resume_budget_usd`, `max_daily_cost_usd`
  (no dollars: every run is `unpriced` and budgets count it as its cap), `inherit_mcp`, `add_dirs`,
  `skills`, `sandbox*`, a body next to `project_agent`. Allowed: `model`, `effort`,
  `on_failure: resume_once`, continued sessions, `env_passthrough`, `timeout_minutes`, the
  concurrency and daily-run caps, `project_agent` ([Copilot links](#copilot-links)).

#### Copilot links

A project that ships Copilot agents in `.github/agents/<name>.agent.md` can be linked like a
Claude project agent:

```markdown
---
harness: copilot
project_agent: reviewer     # <project>/.github/agents/reviewer.agent.md
project: my-app
permission_mode: dontAsk
allowed_tools: ["shell(git)", "read"]
---
```

The run is `copilot --agent reviewer` in the project folder (no `--add-dir`). What was verified on
real runs of Copilot CLI 1.0.114 ([Development](development.md#extending), "Copilot CLI flags"):

- **No body.** Copilot has no channel for instructions next to a project agent (`--agent` is given
  once, there is no system prompt flag, an added directory's instruction files are not read), so a
  Copilot link with a non-empty body is refused at create, update and run start, `system_prompt`
  named. Put the instructions in the project agent's file, or in the run's prompt.
- **The file cannot widen the envelope.** Its `tools:` grant no permission (a declared shell tool
  is still denied without an `--allow-tool` rule) and only narrow what exists (`tools: ["read"]`
  leaves no shell tool even with `shell(ls)` allowed). A run can do what the file declares *and*
  `allowed_tools` allows. `create_agent` warns about an `allowed_tools` rule whose tool the file
  does not declare (`shell` needs `execute` or `shell`, `write` needs `edit` or `write`, `read`
  needs `read`; `url` and `memory` are not checked).
- **Model.** The Duskfleet `model` wins (`--model`); without one, the file's `model:` runs, and the
  run records it.
- A name the project does not define is refused before the run is recorded, with the names
  available.
- **No MCP servers.** Before each run Duskfleet asks `copilot mcp list --json` (in the project
  folder) which servers are configured, user-level, workspace (a trusted folder's `.mcp.json` or
  `.github/mcp.json`) or plugin, and passes one `--disable-mcp-server <name>` per server, so a
  Copilot that also hosts Duskfleet, or any other server, keeps running agents. A listing that fails
  refuses the run with the reason, before it is recorded. A server that loads anyway (the init line
  shows it not `disabled`) still ends the run as failed. Checked on Copilot CLI 1.0.112 on an
  account whose organization disables third-party servers by policy, so every server already showed
  `disabled`; that one loads in a `-p` run on an unmanaged account was not observed, and this is the
  defence for that case.
- User-level Copilot hooks still run in these sessions (there is no flag against them). See
  [Security](security.md).

### Codex agents

`harness: codex` runs the agent with Codex CLI (`codex exec`), under the user's Codex login
(`codex login`). It is available when Duskfleet finds the binary (`codex.binary` in
`duskfleet.yaml`, else `codex` on PATH; `doctor` says `codex not installed` otherwise). Only `own`
agents: Codex has no project-defined agents to link to.

```markdown
---
description: Explains the failing test
harness: codex
permission_mode: dontAsk
effort: low
timeout_minutes: 15
---
Read the failing test and explain why it fails. Change nothing.
```

- **No tool rules, a sandbox.** Codex has no allow-list, so `allowed_tools` and
  `disallowed_tools` are refused. `dontAsk` runs under `-s read-only` (nothing written),
  `acceptEdits` (the default) under `-s workspace-write` (writes in the project only). The network
  is off in both unless the agent opts in (below). Every other mode is refused.
- **Network, opt-in: `codex_network: true`.** Without the network a Codex agent cannot `git push`,
  open a pull request, install a dependency or call an API. With it the run's `workspace-write`
  sandbox reaches **every host** (Codex offers no host list), and its commands act with **your**
  credentials: the `gh` keyring login, SSH keys, git credential helpers. Read
  [Security](security.md#codex-agents-harness-codex) before turning it on. Only with
  `acceptEdits`: a `dontAsk` agent with it is refused, and so is the field on any other harness
  (use `sandbox_allowed_domains` on Claude). `create_agent` / `update_agent` and `agents create`
  answer with a warning that says what it grants, `doctor` lists the agents that have it, and each
  run records a note (the recorded command shows `network_access=true`).

  ```markdown
  ---
  description: Fixes the failing test and opens a pull request
  harness: codex
  permission_mode: acceptEdits
  codex_network: true
  isolated: true
  ---
  Work in your own git worktree. Fix the failing test, push a branch, open a pull request.
  ```

- **Tokens do not reach commands.** Codex removes every variable whose name contains `KEY`,
  `SECRET` or `TOKEN` from the environment of the commands it runs (verified on codex-cli 0.167.1;
  no `shell_environment_policy` override tried brought one back). So `env_passthrough: [GH_TOKEN]`
  has no effect inside a Codex run: create / update accept it but warn. With `codex_network`, `gh`
  uses the machine's keyring login instead.
- **The body is the persona**, passed as Codex's `developer_instructions`. The project's own
  `AGENTS.md` is loaded too. The user's `~/.codex/config.toml` is not (`--ignore-user-config`):
  set `model` in the agent, not there.
- **The project must be a git repository** (`codex exec` checks it).
- **Refused**: `allowed_tools`, `disallowed_tools`, `max_budget_usd`, `wrap_up_reserve_usd`,
  `resume_budget_usd`, `max_daily_cost_usd` (no dollars: every run is `unpriced` and budgets count
  it as its cap), `inherit_mcp`, `add_dirs`, `skills`, `sandbox*`, `claude_agent`. Allowed:
  `model`, `effort`, `env_passthrough`, `timeout_minutes`, `on_failure: resume_once`, the
  concurrency and daily-run caps, `codex_network` (with `acceptEdits`).
- **Sessions resume** (`on_failure: resume_once`, a continued schedule, `run_agent
  { resume_run_id }`) in the same Codex thread, always under the agent's sandbox mode
  (`-c sandbox_mode`): a read-only agent stays read-only on a resume. A thread Codex no longer has
  makes a continued run start a fresh session, with a note. The resume does not pass `model` (only
  the verified flags are used), and whether the persona replaces or adds to the first turn's
  `developer_instructions` on a resume has not been verified.
- A command the sandbox blocked shows as a failed command in the run, not as a denial: the stream
  does not say the sandbox was the cause.

### Cursor agents

`harness: cursor` runs the agent with Cursor Agent CLI (`cursor-agent -p`), under the user's stored
Cursor login (or `CURSOR_API_KEY`, through `env_passthrough`). It is available when Duskfleet finds
the binary (`cursor.binary` in `duskfleet.yaml`, else `cursor-agent` on PATH; `doctor` says
`cursor not installed` otherwise). Only `own` agents: Cursor's project agents
(`.cursor/agents/<name>.md`) run only as subagents, never as the session.

```markdown
---
description: Explains the failing test
harness: cursor
permission_mode: dontAsk
allowed_tools: ["Shell(git)", "Read(**)"]
timeout_minutes: 15
---
Read the failing test and explain why it fails. Change nothing.
```

- **Cursor's own rules.** `allowed_tools` / `disallowed_tools` take Cursor permission rules,
  written verbatim into the agent's `cli-config.json`: `Shell(<command>)`, `Read(<glob>)`,
  `Write(<glob>)`, `WebFetch(<domain>)`. Claude rules (`Bash(...)`, `Edit`, `mcp__*`) and
  `Mcp(...)` are refused by name. A shell command no rule allows is rejected (a denial: the run
  needs review). A `Shell(git)` rule allows every `git` subcommand, `git push` included.
- **`dontAsk`** denies `Write(**)`: the edit tool cannot write. **`acceptEdits`** (the default) lets
  it edit the project with no rule. Every other mode is refused.
- **No MCP**: every MCP tool is denied, `inherit_mcp` is refused.
- **The body is sent ahead of the task**, in a marked block (Cursor has no system prompt option),
  on every run and resume. The project's own `AGENTS.md`, `CLAUDE.md` and `.cursor/rules` apply
  too.
- Taken: `model` (Cursor's ids, `auto` by default), `add_dirs`, `env_passthrough`,
  `timeout_minutes`, `on_failure: resume_once`, the concurrency and daily-run caps. Refused:
  `max_budget_usd` and the other dollar fields (every run is `unpriced`), `effort`, `skills`,
  `sandbox`, `inherit_mcp`, `project_agent`.
- **Sessions resume** in the same Cursor session: the CLI keeps them in the agent's configuration
  directory (`<data>/cursor/<agent id>/`). A session that is not there makes a continued run start
  a fresh session, with a note. Subagents the model starts (`taskToolCall`) are rows of the run.

## Sandbox

`sandbox: true` runs the agent's Bash commands inside Claude Code's native sandbox (macOS
Seatbelt, Linux bubblewrap): writes outside the project and `add_dirs` fail, and the network is
closed except for the exact host names in `sandbox_allowed_domains` (no list = no network).
Use it for agents that read untrusted input (public issues, web pages) or carry a broad
allow-list such as `Bash(node:*)`. Off by default; an agent without it runs exactly as before.

- `sandbox_allowed_domains` and `sandbox_weaker_network_isolation: true` without `sandbox: true`
  are refused by `create_agent` / `update_agent`.
- **`gh` on macOS needs `sandbox_weaker_network_isolation: true`**, next to `github.com` and
  `api.github.com` in `sandbox_allowed_domains`. Without it every `gh` call fails with
  `tls: failed to verify certificate: x509: OSStatus -26276` (Go tools verify TLS through a macOS
  service the sandbox closes); an `add_dirs` entry does not fix that. The key weakens the
  sandbox's network isolation for every command of the run, not only `gh`. A TLS failure is not
  detected: the run is not needs review, so try the agent once before scheduling it.
- A host without the sandbox (Windows; Linux without `bwrap` and `socat`) refuses every run of
  the agent before spawning it; `duskfleet doctor` shows whether the sandbox is available.
- A blocked network connection makes the run **needs review** (`sandbox_blocked`, with a note
  naming the host). A blocked file write is not detected: it reads as an ordinary failed command.
- Git worktrees and the npm cache live outside the project: give them an `add_dirs` entry or
  expect those commands to fail. `gh` read its token from the keychain without one (macOS, with
  the key above).

Details, what was verified and the limits: [security](security.md#opt-in-sandbox-sandbox-true).

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
  of the agent fires while fewer than `n` runs are active and is
  [deferred](schedules.md#busy-ticks-one-deferred-fire) (or `skipped_busy`) otherwise.
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
| `unpriced_policy` | default `count`: runs of unknown cost count at a stand-in amount (below). `allow` = only recorded costs count. CLI `--unpriced count\|allow` |

Every budget covering a run (global, the agent's, the project's) is checked in `startRun`,
after the busy guards and the daily caps, before anything is spawned. A spent hard-stop budget
throws a `BudgetError` (message `budget: the <scope> budget is spent ...`) and pauses every
enabled schedule of the scope (global: all of them; agent: that agent's; project: the schedules
that run on it, by their own `project_id` or their agent's binding). A schedule tick refused
this way is `skipped_budget`. Paused schedules stay paused when the month turns or the budget
is raised or deleted: resume them by hand. A run in progress is not stopped, but it counts while
it runs (below), so parallel runs cannot overshoot a budget their stand-ins already fill.

### Unknown costs fail closed

Every finished run records how its cost is known, `costStatus` (`cost_status`, migration 25):
`reported` (Claude Code's `total_cost_usd` on an API key, or an unknown billing type),
`estimated` (the same number on a subscription: reported, not charged) or `unpriced` (no cost:
the run ended without a `result` line, e.g. a crash, a timeout or a cancel; a run with a wrap-up
pass is `unpriced` when either pass has no cost, never a partial sum). There is no price
table. While a run is pending or running its `costStatus` is null.

Under `unpriced_policy: count` (the default) a budget counts every run of its scope this month
whose cost is unknown, an `unpriced` one or one still running, at a **stand-in**: the cap it
could spend, its worst case. That is the whole cap the run was started with, stored on the row
(migration 26): main pass plus wrap-up reserve, whatever set it (the agent's `max_budget_usd`,
a `run_agent` `max_budget_usd` override, the resume budget of `resume_once`), for a run still
going and a finished one alike. A row from before that migration falls back to the
`--max-budget-usd` of its phases plus the wrap-up reserve when no wrap-up pass was recorded (it
may have died in one); without recorded phases, to the agent's `max_budget_usd`, otherwise
`claude.default_max_budget_usd` (every run is launched with a cap).
A running run is settled by its result. Any finished run without a cost counts, whether or not
it got as far as `started_at` (a pending row swept as an orphan may have spawned its child) and
whatever its `costStatus` (a run closed by a process still on an older build has none). The one
exception is a run the executor refused before spawning anything: it is recorded with a cost of
0 and is not counted. A budget that is `over` only because of
the stand-ins of runs still going (`overByRunning`) refuses new runs but pauses no schedule:
it settles when those runs end.

The migration backfills the finished runs (`reported` / `estimated` by their stored billing
type, `unpriced` where `cost_usd` is NULL), and the unpriced rows of the current month **do
count** after the upgrade: that is the point of failing closed. `duskfleet doctor` lists them
per budget (`unpricedRuns`: run id, agent, stand-in) so a blocked budget is explainable; the
escape hatch is `unpriced_policy: allow` on that budget
(`npm run cli -- budgets set global --amount 200 --unpriced allow`). Setting a budget again
without `unpriced_policy` keeps the policy it has (`count` for a new budget).

The dashboard's **Runs** page shows a banner for each budget at `warn` (amber) or `over`
(coral when it stops runs); `list_budgets` and `duskfleet budgets` report `spentUsd` (recorded
cost), `unpricedRuns`, `runningRuns`, `standInUsd`, `countedUsd` (spent plus stand-ins: what
`percent` and `state` compare with `amount_usd`), `percent`, `state` (`ok` \| `warn` \| `over`),
`overByRunning`, `unpricedPolicy` and `periodStart` for every budget.

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

## Skills

`skills:` gives an agent's runs Claude Code skills that Duskfleet owns, by name:

```markdown
---
id: reviewer
skills: [review-checklist, release-notes]
---
```

A name is a folder holding a `SKILL.md` (the Claude Code skill format), looked up in two places,
the way agents are: `data/skills/<name>/` (private, git-ignored) wins over `config/skills/<name>/`
(committable). Names are lowercase letters, digits and `-`; paths, URLs and git refs are not
accepted. `create_agent` and `update_agent` refuse a name found in neither
directory, and a skill whose files contain a home path or a secret-looking value (the same check
as the agent file). Loading the config never checks them: a skill deleted later is skipped at run
start with a note on the run's timeline, the run still starts.

`config/skills/` is for the skills of *your* checkout that you want to commit; `data/skills/`
is for private ones. The Duskfleet repository itself ships no skills: the ones it uses to
develop itself stay private (git-ignored), and neither folder is part of the npm packages.

The target project is never written. Each run gets a bundle,
`data/skill-bundles/<id>/.claude/skills/<name>` (a copy of the skill's files, never a link to
the live folder), passed with `--add-dir`. `<id>` is a hash of the skills' names and contents: an
edited skill gives the next run a new bundle while a running one keeps what it started with, and
the run records the id it got (`skillsBundle` in `get_run` / `list_runs`) so you can tell which
skills were available. Old bundles stay in `data/skill-bundles/`; deleting the directory is safe,
it is rebuilt when needed.

Symlinks inside a skill folder are refused: `create_agent` / `update_agent` reject a skill that
contains one, and a `SKILL.md` that is a symlink is not found. The skill folder itself may be a
symlink.

The project's own `.claude/skills/` need nothing from here: the run's working directory is the
project, so Claude Code loads them anyway. When a project skill and a bundled one share a name,
Claude Code uses the project's, and the run gets a note saying so.

## Grouping agents by project

`project: <id>` on an agent binds it to an entry of `projects.yaml`. Bound agents are grouped
under their project in `list_agents` (`byProject`) and on the dashboard's Agents page, `run_agent`
targets that project when none is given, and a run on any other project is refused. Agents
without `project` are general-purpose and run wherever they are pointed. A `project` that is
not in `projects.yaml` is a config error, caught before the file is written when it comes
through `create_agent`.

## Reusing agents a project already defines

Projects often ship their own Claude Code agents in `.claude/agents/*.md` (persona, tools,
model). Instead of copying that prompt into Duskfleet, link to it (harness `claude`; see
[Project agents per harness](#project-agents-per-harness) and [Copilot links](#copilot-links) for the others):

```markdown
---
id: my-agent
project_agent: my-agent    # <project>/.claude/agents/my-agent.md (older name: claude_agent)
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

The reverse also holds: an `allowed_tools` entry the project agent's `tools:` does not declare
is not available to the run. `create_agent` and `update_agent` return such entries in
`warnings` (the entry and the project agent file named), and `doctor` lists them under
`link tools`. They are warnings only: the agent is written and keeps running. The comparison is
by tool name (`Bash(gh issue view:*)` is `Bash`), MCP names by server (`mcp__claude_ai_Figma`
and `mcp__claude_ai_Figma__get_screenshot` cover each other). A project agent without `tools:`
inherits every tool, so nothing is reported; one whose frontmatter does not parse gets one note
saying the check was skipped.

A link can leave `description` and `model` out: `list_agents` and `duskfleet agents` then show
the project agent's (`description:` and `model:` of its frontmatter), so the two files never
hold two copies that drift apart. The JSON forms say where each value came from
(`descriptionSource` / `modelSource`: `agent` for the Duskfleet file, `project agent`, or null
when neither sets it). The fallback is for reading only: nothing is written to either file and
the agent's hash does not change, so continued sessions keep matching. A link that sets its own
`model` runs with `--model <it>`, so the Duskfleet value wins over the project agent's;
`duskfleet doctor` prints one advice line under `agents` for each link where the two differ.
A project agent with `model: inherit` (Claude Code's "use the caller's model") counts as setting
no model, and a project folder whose `.claude/agents` cannot be read contributes nothing.

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

The project agent file lives in the project, so a `git pull`, or the agent itself when it may
write there, can change its prompt and its `tools:` between two scheduled runs. Each run
records the file's hash (`projectAgentHash`); when a schedule fires a link whose file changed
since the schedule's previous run of the same agent, the new run gets a note ("project agent file ... changed
since the previous run of this schedule", with both hashes) and `get_run` / `run-info` report
`projectAgentChange.changed: true`. It is a notice only: the run starts as usual, and its
status and review reasons are untouched.

### Which prompt holds which rule

A link has two prompts: the project agent's body (the persona) and the Duskfleet file's body,
appended after it. Write each rule in one of them, never both: two copies drift apart as soon
as one is fixed.

- **The project agent's body** holds the job: what to pick, how to do it, what never to do.
  It must make sense in an interactive Claude Code session too. A rule that would also apply
  to a person running the agent interactively goes here, once.
- **The Duskfleet file's body** holds only what is true because the run is unattended: nobody
  answers questions, shell limits that come from the allow-list, what to do when a tool the
  run needs is not mounted, where the run may write.

For example, "Open one pull request per issue and never push to `main`" belongs in the
project agent; "Nobody can answer questions during this run: when the issue is unclear,
comment on it and stop" belongs in the Duskfleet file.

The two tool lists split the same way: the project agent's `tools:` says what the agent *can*
use (a hard filter, also interactively), the Duskfleet file's `allowed_tools` what it *may* use
without a prompt in an unattended run. A tool missing from `tools:` does not exist in the run;
a tool missing from `allowed_tools` exists but is denied.

A worked example of links and own agents together, on schedules:
[Run a development loop with agents](guides/agent-development-loop.md).

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
stream, so it works for `own` and `link` agents alike. Claude Code also wraps plain Bash calls
in task lines (`task_type: "local_bash"`, seen 2026-11-10): those are not subagents and open no
row. A task line counts when its `task_type` is an agent type (`local_agent`, any `*_agent`), when
it names a `subagent_type`, or when it has no `task_type` at all (older CLIs). Remember that a subagent's own
`tools:` list is a hard filter: a name that does not exist in the run (for instance a
`mcp__plugin_*` prefix) leaves it without that tool, and only the recorded row shows it.
