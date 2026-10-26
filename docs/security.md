# What Duskfleet does and does not confine

Duskfleet starts Claude Code as a local child process and records run data locally. The boundaries below describe Duskfleet's implementation; they are not a promise that an unattended run is safe for every project or host. ([`ClaudeCodeExecutor.execute()`](../packages/core/src/execution/claude-code.ts#L189-L195), [run storage schema](../packages/core/src/storage/db.ts#L19-L64), [data directory configuration](configuration.md#configduskfleetyaml))

## Process and environment

The Claude Code child receives the selected project as its working directory. Duskfleet starts it with `shell: false`, passes its arguments directly, and writes the prompt to stdin rather than adding it to the command line. This avoids Duskfleet interpreting the run command through a shell; it does not sandbox tools or commands Claude Code is allowed to invoke. ([`ClaudeCodeExecutor.execute()`](../packages/core/src/execution/claude-code.ts#L189-L204), [`buildArgv()`](../packages/core/src/execution/claude-code.ts#L80-L117))

[`childEnv()`](../packages/core/src/execution/claude-code.ts#L440-L449) starts from a copy of Duskfleet's process environment, removes `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_*`, and `CLAUDE_BIN`, then adjusts `PATH`. Other environment variables are passed to the child. Keep secrets out of the environment of the process running Duskfleet, or run it under an account whose environment contains only credentials the agent may use. ([`childEnv()`](../packages/core/src/execution/claude-code.ts#L440-L449))

## Project paths and file access

[`validateProjectPath()`](../packages/core/src/orchestration/project-validation.ts#L21-L54) checks that a selected project is an existing directory, refuses the filesystem root and the user's home directory, and—when `allowed_project_roots` is nonempty—refuses project paths outside those roots. The default list is empty, which allows any otherwise-valid project directory. This setting limits which project Duskfleet accepts; it is not an operating-system sandbox for shell commands. ([configuration defaults](configuration.md#configduskfleetyaml), [`validateProjectPath()`](../packages/core/src/orchestration/project-validation.ts#L21-L54))

Duskfleet passes `--permission-prompts none` to unattended Claude Code runs. Its agent documentation says file tools are confined to the project directory unless `add_dirs` widens that scope. Duskfleet passes configured `add_dirs` as `--add-dir`; project-level `add_dirs` apply to every run on that project. ([`buildArgv()`](../packages/core/src/execution/claude-code.ts#L86-L105), [permissions in unattended runs](agents.md#permissions-in-unattended-runs), [project configuration](configuration.md#projects-configprojectsyaml-optional))

## Permissions and command allow-lists

Agent `allowed_tools` and `disallowed_tools` are forwarded to Claude Code as `--allowedTools` and `--disallowedTools`. With `--permission-prompts none`, Duskfleet's agent guide says a tool call not covered by the allow-list is denied and recorded. The allow-list governs Claude Code tool calls; if you allow a shell command or project script, review what that command can do in the project and on the host. ([`buildArgv()`](../packages/core/src/execution/claude-code.ts#L86-L114), [permissions in unattended runs](agents.md#permissions-in-unattended-runs))

## Schedule command gates

Command gates are disabled by default (`scheduler.allow_command_gates: false`). When enabled, a gate runs the configured command through `/bin/sh -c` in the project directory, with the environment of the Duskfleet process. It runs as a shell command outside Claude Code's tool allow-list. Enable command gates only when you trust the schedule configuration and the callers who can create or change schedules. ([configuration defaults](configuration.md#configduskfleetyaml), [`runCommandGate()`](../packages/core/src/scheduler/gate.ts#L114-L140), [`evaluateGate()`](../packages/core/src/scheduler/gate.ts#L251-L262), [`commandGateRefusal()`](../packages/core/src/scheduler/crud.ts#L120-L128))

## Dashboard

The dashboard's `dev` and `start` scripts bind to `127.0.0.1:4777`. Its middleware accepts Host headers for loopback names and rejects other hosts; the code explicitly describes it as localhost-only with no authentication. Keep it on loopback and do not treat its Host check as user authentication. ([dashboard scripts](../apps/web/package.json#L7-L11), [Host check](../apps/web/lib/host.ts#L1-L14), [middleware](../apps/web/middleware.ts#L4-L10))

## What is recorded

The configured `data_dir` defaults to `../data` relative to the configuration directory and holds the SQLite database and logs. The `runs` table includes the project path, prompt, command, result text, raw result JSON, and log path. Run events are stored as JSON payloads; tool-use summaries and captured Git diffs are among the events Duskfleet records. ([configuration defaults](../packages/core/src/config/loader.ts#L59-L64), [data directory resolution](../packages/core/src/config/loader.ts#L152-L158), [`runs` schema](../packages/core/src/storage/db.ts#L19-L64), [`RunRepository.addEvent()` and `diff()`](../packages/core/src/storage/runs.ts#L492-L526), [tool-use events](../packages/core/src/orchestration/run-manager.ts#L1141-L1149), [`recordDiff()`](../packages/core/src/orchestration/run-manager.ts#L1026-L1030))

The per-run JSONL log receives each child stdout line and tagged stderr; stdout is the Claude Code stream-JSON output. Treat both the database and logs as sensitive project data, and set filesystem access, backup, and retention for `data_dir` to match your needs. ([`buildArgv()` stream-JSON option](../packages/core/src/execution/claude-code.ts#L80-L82), [`ClaudeCodeExecutor.execute()` log writes](../packages/core/src/execution/claude-code.ts#L140-L147), [stdout and stderr logging](../packages/core/src/execution/claude-code.ts#L228-L257), [configured data directory](configuration.md#configduskfleetyaml))

## Recommendations

- Run Duskfleet under a dedicated user or process environment that does not contain unrelated credentials; the child inherits the Duskfleet environment as described above. ([`childEnv()`](../packages/core/src/execution/claude-code.ts#L440-L449))
- Set a nonempty `allowed_project_roots` list and review project and agent `add_dirs` entries before unattended use. ([`validateProjectPath()`](../packages/core/src/orchestration/project-validation.ts#L37-L52), [project configuration](configuration.md#projects-configprojectsyaml-optional), [agent configuration](agents.md#frontmatter))
- Keep `scheduler.allow_command_gates` disabled unless the commands and schedule writers are trusted. ([configuration defaults](configuration.md#configduskfleetyaml), [`evaluateGate()`](../packages/core/src/scheduler/gate.ts#L251-L262), [`commandGateRefusal()`](../packages/core/src/scheduler/crud.ts#L120-L128))
- Use an explicit low-cost model while experimenting and configure a maximum budget for agents or runs. ([quick-start warning](../README.md#quick-start), [budget configuration](configuration.md#configduskfleetyaml), [`buildArgv()`](../packages/core/src/execution/claude-code.ts#L110-L114))
- Keep the dashboard bound to loopback; its current Host check does not authenticate users. ([dashboard scripts](../apps/web/package.json#L7-L11), [middleware](../apps/web/middleware.ts#L4-L10))
