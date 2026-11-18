# Harness adapters: one run path, one adapter per agent CLI

A *harness* is an agent CLI that Duskfleet can spawn unattended. Claude Code (`claude`, the
default) and GitHub Copilot CLI (`copilot`, [#446](https://github.com/duskfleet/duskfleet/issues/446))
ship; Codex CLI ([#50](https://github.com/duskfleet/duskfleet/issues/50)) is planned.

## The idea in one paragraph

Duskfleet has **one** run path. Everything that makes a run a Duskfleet run (schedule, guards,
budgets, status transitions, log, diff, timeline, needs-review) lives in that path and knows
nothing about any CLI. Each harness is an **adapter**: it turns a neutral request into that
CLI's command line, and that CLI's output stream into neutral events and one result. An agent
picks its harness with one frontmatter field, `harness:` (default `claude`; see
[Agents](agents.md#harness)).

One path per CLI was rejected: three copies of the guards, the budgets and the review rule would
drift, and every later fix would have to be made three times.

## The picture

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 420}}}%%
flowchart TB
    subgraph entry ["1 · Entry points"]
        chat["Chat host<br/>run_agent over MCP"]
        cli["CLI<br/>duskfleet run"]
        sched["Scheduler tick<br/>due cron"]
    end

    subgraph core ["2 · One run path: RunManager"]
        guards["Guards, daily caps, monthly budgets"]
        fit["Capability check<br/>does the agent fit its harness?"]
        life["Status transitions, log, diff, events, needs-review"]
    end

    registry["3 · Harness registry<br/>harness name to adapter"]

    subgraph adapters ["4 · Adapters, one per harness"]
        a1["Claude adapter<br/>shipped"]
        a2["Codex adapter<br/>planned, issue 50"]
        a3["Copilot adapter<br/>shipped, issue 446"]
    end

    subgraph clis ["5 · Agent CLIs, spawned in the project directory"]
        c1["claude -p<br/>stream-json"]
        c2["codex exec<br/>JSONL"]
        c3["copilot, prompt on stdin<br/>JSONL"]
    end

    store["SQLite and logs<br/>read by the dashboard, the CLI and the MCP tools"]

    chat --> guards
    cli --> guards
    sched --> guards
    guards --> fit
    fit --> registry
    registry --> a1
    registry --> a2
    registry --> a3
    a1 --> c1
    a2 --> c2
    a3 --> c3
    a1 --> life
    a2 --> life
    a3 --> life
    life --> store
```

Read it top to bottom. Boxes 1, 2, 3 and the store exist once. Only boxes 4 and 5 multiply.

## What an adapter is

An adapter implements the `Executor` interface of `packages/core/src/execution/types.ts`:
`harness` (the name agents select), `capabilities` (what it can honour), `binary`, `version()`,
`prepare()` (its own pre-flight checks, before the run row exists) and `execute()`. The adapters
are registered in a `HarnessRegistry` (`packages/core/src/execution/harness.ts`), built in
`packages/mcp/src/bootstrap.ts`; `RunManager` picks one per run from the agent's harness.

| An adapter owns | The run path keeps |
|---|---|
| Finding the binary and reading its version | Concurrency guards (agent, project, global cap) |
| Building the command line and the child's stdin | Daily caps and monthly budgets |
| Its pre-flight checks (Claude: `.claude/agents`, shadowed skills, required MCP servers) | The run row and every status transition |
| Parsing its output stream into neutral events | The JSONL log, its caps and its hash |
| Deciding how a run ends (result line, or inactivity timeout) | The diff of the run |
| Reporting usage, cost when the CLI gives one, denials, session id | The needs-review rule and its reasons |
| Its fixtures and its fake CLI for the tests | Scheduler outcomes, auto-pause, orphans |

The rule of thumb: if a line of code names a CLI flag, a folder such as `.claude/`, or an event
type of one stream, it belongs to an adapter. `RunManager` never contains
`if (harness === "codex")`.

## A run, step by step

```mermaid
sequenceDiagram
    participant C as Caller (tick, MCP, CLI)
    participant R as RunManager
    participant G as Registry
    participant A as Adapter
    participant X as Agent CLI
    participant D as SQLite and log

    C->>R: startRun(agent, project, prompt)
    R->>G: adapter for agent.harness
    G-->>R: adapter and its capabilities
    R->>R: capability check (refuse, naming the field)
    R->>R: guards, daily caps, budgets
    R->>A: prepare(request)
    A-->>R: ok and notes, or a refusal with the reason
    R->>D: run row with its harness, status pending
    R->>A: execute(request, onEvent)
    A->>X: spawn in the project directory
    R->>D: status running
    loop while the CLI runs
        X-->>A: one line of its stream
        A-->>R: neutral event (init, tool_use, text, subagent)
        R->>D: event row and log line
    end
    X-->>A: end of stream, exit code
    A-->>R: one result (outcome, usage, cost or none, denials)
    R->>D: diff, review reasons, final status
    R-->>C: the run
```

Nothing before `prepare` and nothing after the result depends on which CLI ran.

## Capabilities: refuse, never approximate

Agent frontmatter was designed around Claude Code: `permission_mode`, `allowed_tools`,
`inherit_mcp`, `claude_agent`, `skills`, `max_budget_usd`. Another CLI has some of these, a
different version of some, and none of others. Each adapter therefore **declares** what it can
honour, and one function in core (`assertAgentFitsHarness`) compares an agent with its harness,
at create / update time and again at start.

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 360}}}%%
flowchart TB
    start["Agent spec and the capabilities of its harness"]
    known{"Harness registered?"}
    each{"Every field the agent sets<br/>is a declared capability?"}
    prep{"Adapter prepare passes?<br/>project files, servers"}
    refuse1["Refused: unknown harness"]
    refuse2["Refused: the field is named<br/>example: allowed_tools is not supported by harness codex"]
    refuse3["Refused: the adapter's reason"]
    run["Run starts"]

    start --> known
    known -- no --> refuse1
    known -- yes --> each
    each -- no --> refuse2
    each -- yes --> prep
    prep -- no --> refuse3
    prep -- yes --> run
```

Why refusal and not translation: these agents run with nobody watching. An allow-list that an
adapter silently dropped, or mapped onto something wider, is a permission the owner never
granted. A refused agent costs one error message; a quietly widened one costs trust. Claude's
tool rules are never mapped onto Copilot's `--allow-tool`: Copilot matches a shell command by its
first subcommand only (`shell(gh pr)` covers `gh pr merge`), so `Bash(gh pr create:*)` has no
equivalent. A Copilot agent writes Copilot's own rules instead (`toolRule` below).

The capability set. The `claude` and `copilot` columns are what the shipped adapters declare; the
Codex column is an expectation to verify against its `--help` and real runs, not a fact.

| Capability | Meaning | claude | codex (planned) | copilot |
|---|---|---|---|---|
| `toolAllowList` | `allowed_tools` / `disallowed_tools` are enforced | yes | no, a sandbox mode instead | yes, Copilot's own rules (`--allow-tool` / `--deny-tool`) |
| `toolRule` | which entries the CLI takes as written | any | | `shell`, `shell(<cmd>)`, `write`, `write(<path>)`, `read`, `read(<path>)`, `url(<domain>)`, `memory`; anything else refused by name |
| `permissionModes` | `permission_mode` values it accepts | all (`bypassPermissions` still needs `claude.allow_bypass_permissions`) | to map onto sandbox modes | `dontAsk` (the rules only), `acceptEdits` (the rules plus `write`) |
| `resumeSession` | a session can be continued | yes | to verify | yes (`--resume=<id>`) |
| `hardBudgetUsd` | the CLI stops at `max_budget_usd` | yes | no | no (its cap is in AI credits) |
| `reportsCostUsd` | the result carries a cost in dollars | yes | no on a subscription | no (premium requests) |
| `subagents` | nested agents are reported as rows | yes | no | no (later issue) |
| `mcpInherit` | `inherit_mcp` gives the user's connectors | yes | to verify | no (later issue) |
| `projectAgents` | `link` agents (`claude_agent`) | yes | no | no |
| `addDirs` | `add_dirs` | yes | to verify | no: Copilot's `--add-dir` also trusts that directory's skills and agents |
| `skills`, `sandbox` | the fields of the same name | yes | to verify | no (later issues) |
| `effort` | `effort` | yes | to verify | yes (`--reasoning-effort`) |

A harness without `hardBudgetUsd` gets no `--max-budget-usd`-style cap and no wrap-up reserve,
and refuses a budget set for one run as well as the agent's own: a gate's `budget_usd`, a resume
budget (the agent's or the schedule's `resume_budget_usd`), with the field named, before
any row is written. A harness without `resumeSession` refuses `on_failure: resume_once`, and a
continued run of it starts a fresh session with a note. A harness without `reportsCostUsd` never
stores a cost, whatever its adapter returns: every run of it is `unpriced`.

## Cost when the CLI gives no dollars

No new machinery: the existing "unknown costs fail closed" rule covers it
([Agents](agents.md#unknown-costs-fail-closed)).

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 360}}}%%
flowchart TB
    result["Result from the adapter"]
    has{"Cost in dollars reported?"}
    reported["cost_status reported or estimated<br/>counted at its value"]
    unpriced["cost_status unpriced<br/>cost stays empty"]
    budget["Monthly budget:<br/>an unpriced run counts as the cap it started with"]
    daily["max_daily_cost_usd:<br/>refused for the harness, it would read 0"]

    result --> has
    has -- yes --> reported
    has -- no --> unpriced
    unpriced --> budget
    unpriced --> daily
```

So a harness without dollar costs is safe by default, and expensive-looking: every run counts
as its full `max_budget_usd` (or `claude.default_max_budget_usd`). A unit other than dollars
(Copilot's premium requests) is a later issue, not part of the seam.

## What the three harnesses look like through the seam

| | claude (shipped) | codex (#50, planned) | copilot (shipped, #446) |
|---|---|---|---|
| Unattended command | `claude -p --output-format stream-json` | `codex exec --json`, prompt on stdin | `copilot --output-format json`, prompt on stdin |
| Stream | stream-json lines | JSONL events (`thread.started`, `item.completed`, `turn.completed`) | JSONL events (`session.start`, `assistant.message`, `tool.execution_start` / `_complete`) |
| End of run | a `result` line | no result line: inactivity timeout | a `result` line (`exitCode`), also after SIGTERM; none = failed |
| Permissions | allow-list per tool, `--permission-prompts none` | sandbox mode (`workspace-write`, network off) | deny by default in a non-interactive run, `--allow-tool` / `--deny-tool` rules verbatim; `--allow-all*` never |
| System prompt | `--append-system-prompt` | to verify | a per-run agent file, `--add-dir <tmp> --agent duskfleet-agent` |
| Cost | dollars, reported or estimated | unpriced on a subscription | unpriced (premium requests); tokens from `--usage-output-file` |
| Auth | the user's Claude login or API key | per-agent `CODEX_HOME`, `auth.json` linked | the user's GitHub login (`gh` / `copilot login`) |
| `link` agents | yes | no | no |

The Copilot adapter (`core/src/execution/copilot.ts`, parser `copilot-jsonl.ts`) is registered
only when its binary resolves: `COPILOT_BIN`, then `copilot.binary` in `duskfleet.yaml`, then
`copilot` on PATH (on Windows `copilot.exe`, then npm's `copilot.cmd` shim, which is spawned
through `cmd.exe` with every argument escaped, since Node refuses a batch file without a shell). Without one, `doctor` lists `copilot not installed` and an agent on it is
refused at run start. Its parser was written against real runs of Copilot CLI 1.0.112, kept as
fixtures in `packages/mcp/test/fixtures/copilot/` (their README lists what each run shows); the
tests replay them through `fake-copilot.js`.

Two things the Copilot adapter detects and refuses at run time rather than guessing: a user-level
MCP server that loaded anyway (any `session.mcp_servers_loaded` entry not `disabled` ends the run
as failed, until `mcpInherit` exists), and an unknown session on `--resume` (stderr `No session,
task, or name matched`, `sessionNotFound`). A rate limit has no fixture yet, so it is not
classified as `provider_quota`.

## What is *not* a harness

Pointing Claude Code at another model (an Anthropic-compatible endpoint, a gateway) keeps the
harness `claude`: same CLI, same stream, same adapter, only `ANTHROPIC_BASE_URL` and the model
name change. GitHub's cloud coding agent (an issue assigned to Copilot) is not a harness either:
the run happens on GitHub, Duskfleet records nothing.

## Adding a harness: the checklist

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 300}}}%%
flowchart TB
    s1["1 · Verify every flag<br/>against the CLI's --help"]
    s2["2 · Capture real runs as fixtures<br/>an edit, a denial, a failure"]
    s3["3 · Write the fake CLI<br/>that replays them"]
    s4["4 · Declare capabilities honestly<br/>no is a valid answer"]
    s5["5 · Adapter: argv, prepare, parser, end of run"]
    s6["6 · Register it, doctor reports it"]
    s7["7 · Docs: agents, development, security"]
    s8["8 · One real run on the cheapest model<br/>cost stated in the PR"]

    s1 --> s2 --> s3 --> s4 --> s5 --> s6 --> s7 --> s8
```

Fixtures come before code because the stream of a CLI is the contract, and the docs of all
three describe it less precisely than a captured run does. Tests never launch a real CLI. The
same list, with file names: [Development](development.md#extending).

## Where things are

| | |
|---|---|
| Registry, capabilities, the refusal | `packages/core/src/execution/harness.ts` (`HarnessRegistry`, `HarnessCapabilities`, `assertAgentFitsHarness`) |
| The Claude adapter | `packages/core/src/execution/claude-code.ts` (`ClaudeCodeExecutor`, its `prepare`) |
| Which adapters a process has | `packages/mcp/src/bootstrap.ts`; `doctor` prints one line per harness |
| What a run records | `runs.harness` (migration 31, older rows `claude`); the harness's session id and version stay in `claude_session_id` / `claude_code_version` |
| Shared defaults | still `claude.default_timeout_minutes`, `claude.default_max_budget_usd`, `claude.max_log_bytes`, `claude.max_event_bytes`; a neutral home comes with the second harness |
