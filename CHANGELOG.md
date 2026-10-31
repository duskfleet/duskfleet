# Changelog

All notable changes to Duskfleet are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The two npm packages, `duskfleet` and
`@duskfleet/web`, always share one version; a section covers both. How a release is cut:
[docs/development.md "Releasing"](docs/development.md#releasing).

## [Unreleased]

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
- The Publish workflow authenticates with npm trusted publishing (OIDC) instead of an `NPM_TOKEN` secret; the two packages name the repository and `release.yml`, the workflow that starts the run, as their trusted publisher ([#311](https://github.com/duskfleet/duskfleet/pull/311), [#312](https://github.com/duskfleet/duskfleet/pull/312)).
- Runs and schedule command gates get an allow-list of Duskfleet's environment instead of all of it: `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*` and the like no longer reach an agent unless named in `claude.env_passthrough` or an agent's `env_passthrough` ([#185](https://github.com/duskfleet/duskfleet/issues/185)). An agent that used `gh` with a token from the server's environment now needs `env_passthrough: [GH_TOKEN]`.

### Fixed

- `serve` no longer exits after its first tick ([#6](https://github.com/duskfleet/duskfleet/pull/6)).
- Orphan recovery no longer fails a run owned by a live process ([#16](https://github.com/duskfleet/duskfleet/pull/16)) or a fresh run without an owner ([#97](https://github.com/duskfleet/duskfleet/pull/97)).
- An inherited `CLAUDE_BIN` no longer leaks into child runs ([#18](https://github.com/duskfleet/duskfleet/pull/18)).
- An allow-listed MCP server that a run did not use no longer counts as missing ([#165](https://github.com/duskfleet/duskfleet/pull/165)).
- The published packages had `bin` paths with a `./` prefix, which npm 11 drops at publish time, so `npx duskfleet` would have had no executable; the pack gate now refuses such entries and `publish --dry-run` fails when npm auto-corrects the manifest ([#278](https://github.com/duskfleet/duskfleet/pull/278)); the publish job itself now runs that check before each `npm publish`, so a tag cut before the fix cannot ship without its executables ([#312](https://github.com/duskfleet/duskfleet/pull/312)).

[Unreleased]: https://github.com/duskfleet/duskfleet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/duskfleet/duskfleet/releases/tag/v0.1.0
