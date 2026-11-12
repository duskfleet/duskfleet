# Changelog

All notable changes to Duskfleet are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The two npm packages, `duskfleet` and
`@duskfleet/web`, always share one version; a section covers both. How a release is cut:
[docs/development.md "Releasing"](docs/development.md#releasing).

## [Unreleased]

## [0.4.0] - 2026-11-12

One schema migration (29) runs on the first open of an existing database; nothing to do by hand.

### Changed

#### CLI output: human-readable by default, `--json` for scripts

Every data command of the CLI now prints a designed, human-readable view in a terminal; the global
`--json` flag prints exactly what the CLI printed before. **Scripts, hooks and tests that parse the
CLI's stdout must add `--json`**; stderr is unchanged. Colour follows the terminal: a pipe or
`NO_COLOR` gives plain text, `FORCE_COLOR` forces colour, `COLUMNS` (else the terminal width, else
100) sets the table width and narrow terminals drop the least important columns instead of wrapping.

- `run`, `runs`, `run-info`: the rendering infrastructure (`packages/mcp/src/render/`, one pure
  renderer per command, a theme file and shared table / key-value primitives), the runs table with a
  cost footer, `run-info` in sections (Run, Usage, Outcome with the cause and the fix hint,
  Subagents, Diff, Events with `--events`), the `run` result as a header line plus the cause / fix /
  more block. `run --json` prints the trimmed record as before; the new `run --full` prints the
  untrimmed one. The `more:` line reads `duskfleet run-info <id>` ([#429](https://github.com/duskfleet/duskfleet/pull/429)).
- `agents`, `agents create`, `projects`, `schedules`, `schedules run-now`, `budgets`,
  `budgets set` / `delete`: tables and key-value blocks; the scheduler header says which process
  ticks and when its lease ends; a paused schedule shows its reason; the run-now confirmation is on
  stdout in human mode ([#432](https://github.com/duskfleet/duskfleet/pull/432)).
- `doctor`, `install-service`, `uninstall-service`, `mcp status`: `doctor` as a checklist with a
  `n warnings · n errors` summary, advice under its check; the service result as a key-value block;
  one block per host for `mcp status`, env variable names only, never values ([#433](https://github.com/duskfleet/duskfleet/pull/433)).
- The terminal design (DS-33): the colour carries only the glyph (`✓` ok, `●` running, `!` needs
  review, `✗` failed) and the word carries the meaning, so the output reads the same without colour;
  ids and the commands to type are magenta, headings bold, hints dim; every status word is legible
  on dark and light terminal grounds; column orders and truncation rules per screen, with the
  columns that drop first on 80-column terminals ([#434](https://github.com/duskfleet/duskfleet/pull/434)).

### Added

- Dashboard, Alerts: items can be marked seen, one by one, per section or all at once, with Undo.
  Seen items move to a collapsible Seen group at the bottom and come back, marked "New since seen",
  when a new event of the same agent, schedule or budget happens. The nav badge counts unseen items
  only; login / quota errors and a spent hard-stop budget can never be marked seen. Stored in the
  database (migration 29, `attention_acks`), so every viewer sees the same state ([#431](https://github.com/duskfleet/duskfleet/pull/431)).

### Dependencies

- Biome 2.x bump ([#423](https://github.com/duskfleet/duskfleet/pull/423)).

### Fixed

- Subagents: the task lines Claude Code now prints around plain Bash calls (`task_type: "local_bash"`) were recorded as subagents of type `unknown`; they open no subagent row any more ([#438](https://github.com/duskfleet/duskfleet/pull/438)).
- Run diff: the changes recorded for a run no longer include what was already uncommitted in the
  checkout before it started (counted as pre-existing instead), and they now include the git
  worktrees the run created or moved, each with its commits and its patch, also when the worktree
  was removed before the run ended. `run-info` and the run page's Changes section show both. The
  event only gains optional fields: no migration, older runs still render ([#439](https://github.com/duskfleet/duskfleet/pull/439)).

## [0.3.1] - 2026-11-07

No schema change.

### Changed

- README: a busy scheduled tick is deferred as one pending fire, retried until the agent is free or the next occurrence comes; three sentences (Before / after, the How it works diagram, the What you get table) still said it was skipped and never queued. The npm package ships this README ([#421](https://github.com/duskfleet/duskfleet/pull/421)).

## [0.3.0] - 2026-11-07

One schema migration (28) runs on the first open of an existing database; nothing to do by hand.

### Added

#### Runs and agents

- Agents declare `skills: [name, ...]` in their frontmatter; a run gets them through a content-addressed bundle passed with `--add-dir`, so the target project is never written. `data/skills/<name>/` (private) wins over `config/skills/<name>/` (committable); `create_agent` and `update_agent` refuse an unknown skill or one whose files carry home paths or secret-looking values; `runs.skills_bundle` (migration 28) records the bundle, shown as `skillsBundle` by `get_run` ([#396](https://github.com/duskfleet/duskfleet/pull/396)).

#### Schedules

- A usage-limit outage no longer auto-pauses a schedule: `provider_quota` and other `limit` / `transient` failures are left out of the auto-pause streak, and a scheduled fire while the last usage-limit run on this host still has a reset time ahead is recorded as `skipped_quota` ("usage limit until …"), never deferred; manual fires are not held back ([#413](https://github.com/duskfleet/duskfleet/pull/413)).

#### Dashboard

- Alerts page (`/attention`) and its nav badge: everything that needs a human in six fixed sections (login and quota errors with a fix line, failed runs, needs review, schedules auto-paused or in error, budget warnings, repeated skipped busy), one item per cause, gone when the cause is fixed; nothing to dismiss ([#401](https://github.com/duskfleet/duskfleet/pull/401), [#416](https://github.com/duskfleet/duskfleet/pull/416), [#418](https://github.com/duskfleet/duskfleet/pull/418)).
- The Runs tab carries the number of runs running now, from every page; no badge at 0 ([#405](https://github.com/duskfleet/duskfleet/pull/405)).

### Changed

- `install-service` on Linux checks for the systemd user bus before writing anything and refuses with a hint when there is none (containers, WSL without systemd, SSH without linger); `doctor` reports such a unit as not installed instead of telling you to install it ([#415](https://github.com/duskfleet/duskfleet/pull/415)).
- The Schedules page says what each surface can do: MCP creates (`create_schedule`), the dashboard pauses, resumes, edits and runs now, the CLI lists and fires (`schedules run-now`) ([#414](https://github.com/duskfleet/duskfleet/pull/414)).
- The README "How it works" section is two Mermaid diagrams GitHub renders in both themes, instead of PNG exports ([#409](https://github.com/duskfleet/duskfleet/pull/409)).
- Publishing docs: releases go through npm trusted publishing (OIDC); the token is the fallback ([#412](https://github.com/duskfleet/duskfleet/pull/412)).

### Removed

- The Projects page of the dashboard: it duplicated the Agents tables grouped by project and the Runs project filter ([#404](https://github.com/duskfleet/duskfleet/pull/404), [#419](https://github.com/duskfleet/duskfleet/pull/419)).

### Fixed

- "You've hit your 5-hour limit" (and any hyphenated window) is classified as `provider_quota`, with its reset time, instead of a generic failure ([#407](https://github.com/duskfleet/duskfleet/pull/407)).

## [0.2.0] - 2026-11-05

Six schema migrations (22 to 27) run on the first open of an existing database; nothing to do by hand. See the upgrade note under Changed for monthly budgets.

### Added

#### Runs and agents

- Continue a previous run's session: `run_agent { resume_run_id }` and a schedule's `continue: true` send a new prompt into the Claude session of an ended run (`continued_from_run_id`, migration 23); a session that cannot be continued starts fresh with a note, never a skipped tick ([#384](https://github.com/duskfleet/duskfleet/pull/384)).
- Optional `title` on runs and schedules (migration 24): `run_agent`, `create_schedule`, `run --title`; every list shows a run under its title, else its first prompt line ([#391](https://github.com/duskfleet/duskfleet/pull/391), [#395](https://github.com/duskfleet/duskfleet/pull/395)).
- Log caps: `claude.max_event_bytes` (64 KiB per stored event, the envelope kept) and `claude.max_log_bytes` (50 MiB per raw `.jsonl`), with `log_bytes`, `log_sha256` and `log_truncated` on the run (migration 27) ([#393](https://github.com/duskfleet/duskfleet/pull/393)).
- Evals foundation: the `evals.details` schema and one scoring rule (hard checks first, then rubric dimensions), evaluators that never touch `runs` ([#375](https://github.com/duskfleet/duskfleet/pull/375)); an LLM judge as a second read-only Claude Code run on a PASS/FAIL rubric ([#378](https://github.com/duskfleet/duskfleet/pull/378)).
- Smoke test for builtin agents: every `config/agents/*.md` must load with an explicit unattended envelope ([#376](https://github.com/duskfleet/duskfleet/pull/376)).

#### Schedules

- A busy fire is deferred instead of lost: `scheduler.defer_busy` (default on) keeps one pending fire per schedule (migration 22), retried every tick until it starts or the next cron occurrence comes ([#224](https://github.com/duskfleet/duskfleet/pull/224)).
- `scheduler.auto_pause` on/off switch, in the file and in Settings ([#323](https://github.com/duskfleet/duskfleet/pull/323)).
- One schedule per agent: a second schedule is refused on create or agent change; `doctor` lists the duplicates an older database holds ([#322](https://github.com/duskfleet/duskfleet/pull/322)).
- `install-service` on macOS runs `serve` under `caffeinate` (`--keep-awake`, default; holds on AC power only), and `doctor` reports it: a sleeping Mac skipped every scheduled run ([#380](https://github.com/duskfleet/duskfleet/pull/380)).

#### CLI

- Guided first run at the end of `init`, and `run --first` ([#324](https://github.com/duskfleet/duskfleet/pull/324)).
- `init` without a Claude login writes the config, prints the fix and exits 0 ([#363](https://github.com/duskfleet/duskfleet/pull/363)).
- Per-command `--help`; an unknown command or a missing argument is named, exit 2 ([#365](https://github.com/duskfleet/duskfleet/pull/365)).
- `run --project` accepts a relative path, resolved from the shell directory ([#367](https://github.com/duskfleet/duskfleet/pull/367)).
- A failed `run` prints its cause and the fix first; the full JSON only with `--json` ([#361](https://github.com/duskfleet/duskfleet/pull/361)).

#### Dashboard

- Agents as table rows per project with KPI tiles, filters and sort, and a new agent detail page ([#316](https://github.com/duskfleet/duskfleet/pull/316)); card layout from tablet width ([#330](https://github.com/duskfleet/duskfleet/pull/330)); sorted by id, status column fits the needs-review pill ([#333](https://github.com/duskfleet/duskfleet/pull/333), [#335](https://github.com/duskfleet/duskfleet/pull/335)); Run now says when a fire is already requested ([#337](https://github.com/duskfleet/duskfleet/pull/337)).
- Costs page in the Trends style: ranked table with ticks and the split in the table head ([#373](https://github.com/duskfleet/duskfleet/pull/373)); a By model row opens Runs filtered by that model, `?model=` ([#390](https://github.com/duskfleet/duskfleet/pull/390)).
- Clean-rate chart with many agents: ranked table plus the selected lines, at most six drawn ([#315](https://github.com/duskfleet/duskfleet/pull/315)).
- Schedule cards with the actions in the header and the message as a strip ([#334](https://github.com/duskfleet/duskfleet/pull/334)); Running and Recent runs on one shared column grid ([#336](https://github.com/duskfleet/duskfleet/pull/336)).
- Copy-paste commands and the MCP setup rendered for the install in use (checkout, global or npx); the wrap-up reserve explained on the run page ([#358](https://github.com/duskfleet/duskfleet/pull/358)).
- Measured WCAG AA contrast of the tokens and badges in both modes, kept by a test ([#388](https://github.com/duskfleet/duskfleet/pull/388)); render tests for the components ([#356](https://github.com/duskfleet/duskfleet/pull/356)).

#### Docs

- Guide: run Claude Code on a schedule on your own machine, and what Duskfleet adds ([#263](https://github.com/duskfleet/duskfleet/pull/263)).
- README written around `npx duskfleet`: quick start, Before / after, Commands table, FAQ, hero images and the "How a run works" diagram, wide and phone, dark and light ([#357](https://github.com/duskfleet/duskfleet/pull/357), [#369](https://github.com/duskfleet/duskfleet/pull/369), [#370](https://github.com/duskfleet/duskfleet/pull/370), [#346](https://github.com/duskfleet/duskfleet/pull/346), [#360](https://github.com/duskfleet/duskfleet/pull/360), [#398](https://github.com/duskfleet/duskfleet/pull/398), [#402](https://github.com/duskfleet/duskfleet/pull/402)).

### Changed

- CLI quiet by default (`warn`), migrations reported in one line, `--verbose` brings `info` back and `DUSKFLEET_LOG_LEVEL` wins; `serve` and the MCP server keep `info` ([#366](https://github.com/duskfleet/duskfleet/pull/366)).
- `/runs` redirects to the run list; the dashboard no longer claims to be read-only where it edits schedules ([#364](https://github.com/duskfleet/duskfleet/pull/364)).
- Costs page without the Budget warning tile ([#342](https://github.com/duskfleet/duskfleet/pull/342)); Runs page without the "Spend by model moved" line ([#341](https://github.com/duskfleet/duskfleet/pull/341)).
- Publishing: unattended `npm publish` with a bypass-2FA token until the registry accepts this repository's OIDC token, the exchange logged verbose ([#314](https://github.com/duskfleet/duskfleet/pull/314), [#318](https://github.com/duskfleet/duskfleet/pull/318)).
- Budgets fail closed on unknown run cost: every finished run records `cost_status` (`reported`, `estimated` on a subscription, `unpriced` without a cost; migration 25), and under the new per-budget `unpriced_policy: count` (default) an unpriced or still running run counts as the whole cap it started with (wrap-up reserve included, stored on the run by migration 26 so a `run_agent` `max_budget_usd` override or a resume budget counts as such; else its agent's `max_budget_usd`, else `claude.default_max_budget_usd`), including runs closed without `cost_status` by an older build and runs without `started_at`; only a spawn refused before launching anything is recorded at cost 0; `set_budget` without `unpriced_policy` keeps a budget's stored policy. **Upgrade note:** existing finished runs are backfilled and the unpriced ones of the current month count at once, so a hard-stop budget may refuse runs right after the upgrade; `duskfleet doctor` lists them per budget, and `unpriced_policy: allow` (`budgets set ... --unpriced allow`, `set_budget`) ignores them ([#58](https://github.com/duskfleet/duskfleet/issues/58)).

### Fixed

- A run that spawned but could not be marked `running` (a "database is locked" write at a
  wake-up with several Duskfleet processes) was left `pending` forever while its child ran to
  the result: the end listener was attached after the failing write, and the orphan sweep leaves
  a live owner's rows alone. The listener now comes first, the child is stopped and the row ends
  `failed` with the reason. The database is opened with a 5 s busy timeout, so writes from
  `serve`, MCP servers, the CLI and the dashboard wait for each other instead of failing ([#381](https://github.com/duskfleet/duskfleet/pull/381)).
- A `pending` run whose owner is gone is swept like a `running` orphan, and "running now" has one definition everywhere ([#329](https://github.com/duskfleet/duskfleet/pull/329)).
- Costs page charts: end labels a line box apart, long names truncate instead of pushing the value out, total row aligned ([#394](https://github.com/duskfleet/duskfleet/pull/394)).

## [0.1.0] - 2026-10-31

First public release. Duskfleet runs Claude Code agents unattended in your projects, from an MCP
server, a CLI or a schedule, records every run in a local SQLite database, and shows them in a
localhost dashboard.

### Added

#### Runs and agents

- Subagent records: one row per Agent call with its type, brief, report, tool calls and duration ([#4](https://github.com/duskfleet/duskfleet/pull/4), [#13](https://github.com/duskfleet/duskfleet/pull/13)).
- One "needs review" rule for failed, timed-out, orphaned, budget-exhausted and non-zero-exit runs ([#11](https://github.com/duskfleet/duskfleet/pull/11)); a run that completes without a single tool call needs review too ([#192](https://github.com/duskfleet/duskfleet/pull/192)).
- Budget reserve and wrap-up pass: a run that exhausts its budget records where it stopped ([#10](https://github.com/duskfleet/duskfleet/pull/10)).
- Per-agent concurrency limits, `max_concurrent` and `isolated` ([#34](https://github.com/duskfleet/duskfleet/pull/34)).
- Daily caps per agent, `max_daily_runs` and `max_daily_cost_usd` ([#120](https://github.com/duskfleet/duskfleet/pull/120)).
- Monthly budgets per scope (global, agent or project) with an optional hard stop that pauses the scope's schedules ([#163](https://github.com/duskfleet/duskfleet/pull/163)).
- Structured failure classification on every failed run, `error_code` and `error_family` ([#139](https://github.com/duskfleet/duskfleet/pull/139)).
- Usage and cost per model ([#115](https://github.com/duskfleet/duskfleet/pull/115)), billing type (API or subscription) ([#121](https://github.com/duskfleet/duskfleet/pull/121)), and the agent hash, model used and Claude Code version on every run ([#207](https://github.com/duskfleet/duskfleet/pull/207)).
- The git diff of a run recorded as a run event ([#122](https://github.com/duskfleet/duskfleet/pull/122)).
- A run whose MCP connectors did not load is restarted once before its first model turn ([#127](https://github.com/duskfleet/duskfleet/pull/127)).
- The child process is killed after a grace period once its result line is in ([#116](https://github.com/duskfleet/duskfleet/pull/116)).
- Agent files are checked on create and update: home paths and secret-looking values are refused ([#123](https://github.com/duskfleet/duskfleet/pull/123)).
- `duskfleet agents create` writes your own agent from the CLI; the Quick start uses it for your first agent ([#246](https://github.com/duskfleet/duskfleet/pull/246)).
- Agent patterns: `pr-check-loop` ([#193](https://github.com/duskfleet/duskfleet/pull/193)) and `why-work-stopped`, a read-only diagnosis agent over the Duskfleet database ([#195](https://github.com/duskfleet/duskfleet/pull/195)).

#### Schedules

- Unattended schedules: `install-service` registers `duskfleet serve` with launchd, systemd `--user` or Task Scheduler; one lease holder fires the schedules; cron and time zone are editable on the dashboard ([#3](https://github.com/duskfleet/duskfleet/pull/3)). The `serve` process takes the lease over from the MCP server and the CLI ([#7](https://github.com/duskfleet/duskfleet/pull/7)).
- Run now: a dashboard button per schedule ([#5](https://github.com/duskfleet/duskfleet/pull/5)) and `duskfleet schedules run-now` for git hooks and scripts ([#19](https://github.com/duskfleet/duskfleet/pull/19)).
- A schedule's next tick resumes a run that ran out of budget or time, once ([#12](https://github.com/duskfleet/duskfleet/pull/12)).
- Schedule gates skip a tick cheaply when there is no work ([#15](https://github.com/duskfleet/duskfleet/pull/15)); command gates are opt-in through `scheduler.allow_command_gates` ([#222](https://github.com/duskfleet/duskfleet/pull/222)).
- Idle cost per schedule: fires, no-op runs and their dollars over 7 days ([#14](https://github.com/duskfleet/duskfleet/pull/14)).
- Compare-and-set claim when firing a schedule, so two processes never fire the same tick ([#119](https://github.com/duskfleet/duskfleet/pull/119)).
- Auto-pause of schedules that keep producing empty or needs-review runs ([#161](https://github.com/duskfleet/duskfleet/pull/161)).
- Concurrency and catch-up policies on schedules ([#162](https://github.com/duskfleet/duskfleet/pull/162)), the `pause_scheduler` tool and `trigger_kind` ([#206](https://github.com/duskfleet/duskfleet/pull/206)).

#### CLI

- `run --project` accepts a registered project id ([#8](https://github.com/duskfleet/duskfleet/pull/8)).
- `doctor --probe`: an optional live hello run ([#142](https://github.com/duskfleet/duskfleet/pull/142)).
- `--version` on both bins, and help that ends with the `init` hint ([#247](https://github.com/duskfleet/duskfleet/pull/247)).
- A plain message, instead of a stack trace, on Node older than 24 ([#227](https://github.com/duskfleet/duskfleet/pull/227)).
- A default `PATH` when the server is launched from a GUI host ([#225](https://github.com/duskfleet/duskfleet/pull/225)).

#### Dashboard

- The dashboard design: brand tokens and typography, the D-sail mark, app shell, shared primitives, and the Runs, Run detail, Agents, Schedules and MCP pages ([#17](https://github.com/duskfleet/duskfleet/pull/17), [#21](https://github.com/duskfleet/duskfleet/pull/21), [#22](https://github.com/duskfleet/duskfleet/pull/22), [#23](https://github.com/duskfleet/duskfleet/pull/23), [#24](https://github.com/duskfleet/duskfleet/pull/24), [#25](https://github.com/duskfleet/duskfleet/pull/25), [#26](https://github.com/duskfleet/duskfleet/pull/26), [#27](https://github.com/duskfleet/duskfleet/pull/27), [#28](https://github.com/duskfleet/duskfleet/pull/28), [#191](https://github.com/duskfleet/duskfleet/pull/191)).
- Connect snippets with absolute paths on the MCP page ([#2](https://github.com/duskfleet/duskfleet/pull/2)), and a filter by tool or parameter name ([#235](https://github.com/duskfleet/duskfleet/pull/235)).
- The agent's description on the run page and on linked agent cards ([#9](https://github.com/duskfleet/duskfleet/pull/9)).
- Schedules grouped by project, or by the agent's project when the schedule has none ([#110](https://github.com/duskfleet/duskfleet/pull/110), [#118](https://github.com/duskfleet/duskfleet/pull/118)).
- A silent-run badge for a running run with no recent event ([#164](https://github.com/duskfleet/duskfleet/pull/164)).
- The needs-review tile works as a filter, with the outcome and reason in the URL ([#229](https://github.com/duskfleet/duskfleet/pull/229)).
- The dashboard binds to localhost and rejects foreign `Host` headers ([#223](https://github.com/duskfleet/duskfleet/pull/223)).

#### Packages and docs

- npm packages `duskfleet` (CLI and MCP server) and `@duskfleet/web` (dashboard) at the same version ([#230](https://github.com/duskfleet/duskfleet/pull/230), [#243](https://github.com/duskfleet/duskfleet/pull/243)), published with provenance from a tag ([#239](https://github.com/duskfleet/duskfleet/pull/239)).
- README landing page ([#114](https://github.com/duskfleet/duskfleet/pull/114)), "How it works" with run-flow and lifecycle diagrams ([#96](https://github.com/duskfleet/duskfleet/pull/96)), troubleshooting for unattended runs ([#241](https://github.com/duskfleet/duskfleet/pull/241)), security policy and threat model ([#234](https://github.com/duskfleet/duskfleet/pull/234)).
- Windows support marked experimental, with a test plan ([#245](https://github.com/duskfleet/duskfleet/pull/245)).
- A Release workflow in the Actions tab: run it on `main` with the version, it tags, creates the GitHub release from the CHANGELOG section and publishes both packages ([#273](https://github.com/duskfleet/duskfleet/pull/273)).

### Changed

- The prompt reaches Claude Code on stdin instead of the command line ([#140](https://github.com/duskfleet/duskfleet/pull/140)).
- Default limits: one run per agent, four per project, eight overall ([#218](https://github.com/duskfleet/duskfleet/pull/218), [#233](https://github.com/duskfleet/duskfleet/pull/233)).
- The name is written "Duskfleet" everywhere, with a new tagline ([#221](https://github.com/duskfleet/duskfleet/pull/221)); brand assets rebuilt from the new design ([#212](https://github.com/duskfleet/duskfleet/pull/212)).
- Dashboard: a more readable night palette and type ramp ([#240](https://github.com/duskfleet/duskfleet/pull/240)); the agent state badge stays on the title row ([#232](https://github.com/duskfleet/duskfleet/pull/232)).
- Next.js telemetry is disabled in the dashboard scripts ([#231](https://github.com/duskfleet/duskfleet/pull/231)).
- The Publish workflow publishes both packages unattended with an `NPM_TOKEN` granular token (publish, 2FA bypass); npm trusted publishing (OIDC) is configured too, tried first, and takes over once the registry accepts this repository's immutable OIDC subject ([npm/cli#9969](https://github.com/npm/cli/issues/9969)) ([#311](https://github.com/duskfleet/duskfleet/pull/311), [#312](https://github.com/duskfleet/duskfleet/pull/312), [#317](https://github.com/duskfleet/duskfleet/pull/317), [#318](https://github.com/duskfleet/duskfleet/pull/318)).
- Runs and schedule command gates get an allow-list of Duskfleet's environment instead of all of it: `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*` and the like no longer reach an agent unless named in `claude.env_passthrough` or an agent's `env_passthrough` ([#185](https://github.com/duskfleet/duskfleet/issues/185)). An agent that used `gh` with a token from the server's environment now needs `env_passthrough: [GH_TOKEN]`.

### Fixed

- `serve` no longer exits after its first tick ([#6](https://github.com/duskfleet/duskfleet/pull/6)).
- Orphan recovery no longer fails a run owned by a live process ([#16](https://github.com/duskfleet/duskfleet/pull/16)) or a fresh run without an owner ([#97](https://github.com/duskfleet/duskfleet/pull/97)).
- An inherited `CLAUDE_BIN` no longer leaks into child runs ([#18](https://github.com/duskfleet/duskfleet/pull/18)).
- An allow-listed MCP server that a run did not use no longer counts as missing ([#165](https://github.com/duskfleet/duskfleet/pull/165)).
- The published packages had `bin` paths with a `./` prefix, which npm 11 drops at publish time, so `npx duskfleet` would have had no executable; the pack gate now refuses such entries and `publish --dry-run` fails when npm auto-corrects the manifest ([#278](https://github.com/duskfleet/duskfleet/pull/278)); the publish job itself now runs that check before each `npm publish`, so a tag cut before the fix cannot ship without its executables ([#312](https://github.com/duskfleet/duskfleet/pull/312)).

[Unreleased]: https://github.com/duskfleet/duskfleet/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/duskfleet/duskfleet/releases/tag/v0.4.0
[0.3.1]: https://github.com/duskfleet/duskfleet/releases/tag/v0.3.1
[0.3.0]: https://github.com/duskfleet/duskfleet/releases/tag/v0.3.0
[0.2.0]: https://github.com/duskfleet/duskfleet/releases/tag/v0.2.0
[0.1.0]: https://github.com/duskfleet/duskfleet/releases/tag/v0.1.0
