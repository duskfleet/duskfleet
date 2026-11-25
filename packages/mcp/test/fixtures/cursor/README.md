# Cursor CLI fixtures

Real runs of **Cursor Agent CLI 2026.11.19-f005e9d** (`cursor-agent`, also installed as `agent`)
on macOS, captured on 2026-11-24 for the Cursor harness (issue #467). They are the contract the
adapter's parser is written against; tests replay them through a fake CLI and never launch the
real one.

Every run was made in a scratch git repository holding a `README.md`, logged in with a Cursor
account (`cursor-agent status`: "Logged in as ...", `apiKeySource: "login"` in the stream), on the
model `auto`. No run reports a cost: the stream carries token counts only.

## Files

`<name>.jsonl` is stdout (`--output-format stream-json`), `<name>.stderr` stderr. A file that
would be empty is left out: every run with a `.jsonl` here printed nothing on stderr, and the two
with only a `.stderr` printed nothing on stdout.

Common flags, left out of the table: `cursor-agent -p --output-format stream-json --trust --model
auto`. Unless the table says otherwise the prompt is the last argument, stdin is `/dev/null` and
the configuration directory is the user's own (`~/.cursor`), whose `cli-config.json` held
`permissions.allow: ["Shell(ls)"]`, `approvalMode: "allowlist"` and `sandbox.mode: "disabled"`.

`<cfg>` is a per-run directory given as `CURSOR_CONFIG_DIR=<cfg>`, created with one file,
`cli-config.json`, holding `{"version":1,"permissions":{"allow":[...],"deny":[...]}}` with the
lists of the table.

| Fixture                | Differences from the common flags                                     | Prompt                                                    | Exit |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- | ---- |
| `untrusted`            | no `--trust`                                                          | create `hello.txt`                                        | 1    |
| `edit`                 |                                                                       | create `hello.txt`                                        | 0    |
| `shell-denied`         |                                                                       | run `git status --short .`                                | 0    |
| `shell-allowed`        | `<cfg>` allow `Shell(git)`                                            | run `git status --short .`                                | 0    |
| `write-denied`         | `<cfg>` deny `Write(**)`                                              | create `denied.txt`                                       | 0    |
| `force`                | `<cfg>` with empty lists, `--force`                                   | run `git log --oneline .`                                 | 0    |
| `sandbox`              | `<cfg>` allow `Shell(curl)`, `Shell(touch)`; `--sandbox enabled`      | `curl` `https://example.com`, `touch` outside the project | 0    |
| `ask-write`            | `--mode ask`                                                          | create `ask.txt`                                          | 0    |
| `failed-model`         | `--model no-such-model`                                               | "Say hi"                                                  | 1    |
| `resume`               | `--resume <session of edit>`                                          | "What file did you create earlier?"                       | 0    |
| `resume-unknown`       | `--resume 00000000-0000-4000-8000-000000000000`                       | "Say hi"                                                  | 0    |
| `resume-same-config`   | `<cfg>` of `shell-allowed`, `--resume <session of shell-allowed>`     | "Which shell command did you run earlier?"                | 0    |
| `resume-other-config`  | the user's own directory, `--resume <session of shell-allowed>`       | "Which shell command did you run earlier?"                | 0    |
| `stdin`                | no prompt argument: the prompt is piped on stdin                      | "Reply with exactly: stdin works"                         | 0    |
| `killed`               | SIGTERM after 16 s                                                    | a 3000 word essay                                         | 143  |
| `add-dir-instructions` | `<cfg>` with empty lists, `--add-dir <dir>` holding an `AGENTS.md`    | "Say hi in three words."                                  | 0    |
| `plugin-dir-rule`      | `<cfg>` with empty lists, `--plugin-dir <dir>` holding a rule         | "Say hi in three words."                                  | 0    |
| `subagent`             | `<cfg>` with empty lists, a `.cursor/agents/parrot.md` in the project | "/parrot what is the capital of France?"                  | 0    |

The four `mcp-*` runs were captured on 2026-11-25 with **2026.11.22-e9042b2** (the CLI updates
itself), in a scratch project holding a `.cursor/mcp.json` that declares one stdio server,
`duskfleet-probe`, with one tool, `probe_secret`. The server logged every start and request to a
file outside the project. Their prompt: "Call the MCP tool probe_secret of the server
duskfleet-probe and reply with exactly its output. If you have no such tool or the call is refused,
reply exactly NO_TOOL and nothing else."

| Fixture          | Differences from the common flags                                                    | Exit |
| ---------------- | ------------------------------------------------------------------------------------ | ---- |
| `mcp-unapproved` | `<cfg>` with empty lists                                                             | 0    |
| `mcp-no-rule`    | `<cfg>` with empty lists, `--approve-mcps`                                           | 0    |
| `mcp-allowed`    | `<cfg>` allow `Mcp(duskfleet-probe:probe_secret)`, `--approve-mcps`                  | 0    |
| `mcp-denied`     | `<cfg>` allow `Mcp(duskfleet-probe:probe_secret)`, deny `Mcp(*:*)`, `--approve-mcps` | 0    |

The `AGENTS.md` of `add-dir-instructions` and the rule of `plugin-dir-rule`
(`<dir>/.cursor-plugin/plugin.json` plus `<dir>/rules/duskfleet.mdc` with `alwaysApply: true`) both
said "Always end every reply with the word PINEAPPLE on its own line."

## What the runs show

**Stream**

- One JSON object per line, every one with the `session_id`. A run is `system` / `init`
  (`session_id`, `cwd`, `model`: the display name, `"Auto"` here; `permissionMode`; `apiKeySource`),
  then `user` (the prompt), then `thinking`, `assistant` and `tool_call` lines, then `result`.
- `result` is the last line of a run that ended on its own: `subtype: "success"`, `is_error`,
  `duration_ms`, `duration_api_ms`, `request_id`, `result` and `usage` (`inputTokens`,
  `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`). There is no cost
  field and no turn count.
- `result.result` is every assistant message of the run joined with no separator
  (`"...single line.Created ..."` in `edit`). The final text is the last `assistant` line.
- `thinking` lines (`subtype: "delta"` with `text`, then `"completed"`) arrive without
  `--stream-partial-output`; they are many and carry no state.
- An `assistant` line is one complete message (`message.content[0].text`). Those followed by a
  tool call carry `model_call_id` and `timestamp_ms`; the last one of the run carries neither.
- A tool call is a `tool_call` pair, `subtype: "started"` then `"completed"`, with the same
  `call_id` (it contains a newline character). `tool_call` holds one key naming the tool, with
  `args` and, when completed, `result`. Tools seen: `editToolCall` (`args.path`, absolute),
  `shellToolCall` (`args.command`), `taskToolCall`, `getMcpToolsToolCall` and `mcpToolCall`.
- Two tool calls can be open at once: in `sandbox` both start before either completes, and they
  complete in the other order.

**Permissions**

- A folder the CLI does not trust yet: nothing on stdout, a "Workspace Trust Required" notice on
  stderr, exit code 1 (`untrusted`). `--trust` is needed on every run; the notice also names
  `--force`.
- Without `--force`, a file edit inside the project runs with no rule (`edit`), and a shell
  command that no rule allows is rejected without a prompt: the completed `shellToolCall` has
  `result.rejected` (`command`, `workingDirectory`, an empty `reason`) (`shell-denied`). The model
  tried three times; the run still ends `success` with exit code 0.
- `permissions.allow: ["Shell(git)"]` lets the same command run: `result.success` with `exitCode`,
  `stdout`, `stderr` (`shell-allowed`).
- `permissions.deny: ["Write(**)"]` blocks the edit tool: `result.writePermissionDenied` (`path`,
  `error` ending in "Blocked by permissions configuration") (`write-denied`). The model then tried
  a shell redirect, rejected like any shell command no rule allows.
- `--force` runs a shell command no rule allows (`force`). `permissionMode` in `init` is
  `"default"` in every run, `--force` and `--mode ask` included: it does not tell them apart.
- `--mode ask`: the model answered that it cannot edit in Ask mode and called no tool
  (`ask-write`). No refusal by the CLI is shown, so the fixture proves nothing about enforcement.
- `--sandbox enabled` changed nothing observable for commands allowed by a rule: `curl` reached
  the network (HTTP 200) and `touch` created a file outside the project (`sandbox`). A
  `Shell(<command>)` rule does not confine the command's paths.

**Configuration directory**

- `CURSOR_CONFIG_DIR=<cfg>` replaces `~/.cursor` for `cli-config.json`, and the login still works
  with nothing but that file in it. The CLI rewrites the file on the first run (it keeps
  `permissions` and adds its defaults, `approvalMode: "allowlist"`, and an `authInfo` block naming
  the account) and creates `chats/` and `statsig-cache.json` next to it.
- Sessions live in the configuration directory (`<cfg>/chats/<hash>/<session id>/`). Resumed with
  the directory it was created in, a session remembers (`resume-same-config`); resumed with
  another one, the run starts empty under the same id, with no error (`resume-other-config`).
- `cursor-agent mcp list` named the same server from the user's `~/.cursor/mcp.json` with and
  without `CURSOR_CONFIG_DIR`: the variable does not hide the user's MCP servers.

**MCP servers**

- A server declared in the project's `.cursor/mcp.json` and never approved is not loaded:
  `cursor-agent mcp list` says `not loaded (needs approval)`, the server process is never started
  and the model finds no tool (`getMcpToolsToolCall` with no match, `mcp-unapproved`).
- `--approve-mcps` approves it and the approval outlives the run: it is written to
  `~/.cursor/projects/<project slug>/mcp-approvals.json`, in the user's home whatever
  `CURSOR_CONFIG_DIR` says. After one run with the flag, `mcp list` says `ready` for that project
  from any configuration directory.
- An approved server is started and its tools are listed to the model, but a call that no rule
  allows is rejected without a prompt, like a shell command: the completed `mcpToolCall` has
  `result.rejected` (`reason`: "User rejected MCP: <server>-<tool>") and the server receives no
  `tools/call` (`mcp-no-rule`).
- `permissions.allow: ["Mcp(<server>:<tool>)"]` lets the call run: `result.success` with
  `content[].text.text` and `isError` (`mcp-allowed`).
- `permissions.deny: ["Mcp(*:*)"]` wins over that allow rule: `result.permissionDenied` (`error`
  ending in "Blocked by permissions configuration"), no `tools/call` (`mcp-denied`).
- `mcpToolCall.args` holds `name` (`<server>-<tool>`), `providerIdentifier` (the server),
  `toolName` and `args`.
- Not shown by a run: a server of the user's own `~/.cursor/mcp.json`. `mcp list` tried to connect
  to the one on this machine in a project where nothing had been approved (it is not in that
  project's `mcp-approvals.json`), which suggests user-level servers need no approval; that server
  did not connect, so no run called it.
- The CLI also writes a transcript of every run under
  `~/.cursor/projects/<project slug>/agent-transcripts/`, again outside `CURSOR_CONFIG_DIR`.

**Sessions and failures**

- `--resume <session id> "<prompt>"` continues the session and reports the same `session_id`
  (`resume`).
- An unknown id is not an error: `--resume <any uuid>` starts a fresh session with that id, exit
  code 0 (`resume-unknown`). Nothing in the stream tells a resumed session from a new one.
- An unknown model: nothing on stdout, one line on stderr (`Cannot use this model: ...` followed
  by the account's model list), exit code 1 (`failed-model`). There is no `result` line.
- SIGTERM: the stream stops where it was (`init` and `user` only, 16 s in), exit code 143, no
  terminal event (`killed`).
- With no prompt argument the prompt is read from stdin (`stdin`).

**Instructions and project agents**

- `cursor-agent --help` lists no system prompt or instructions option.
- An `AGENTS.md` in a directory given with `--add-dir` is not applied (`add-dir-instructions`),
  and neither is an always-apply rule in a directory given with `--plugin-dir`, in the layout
  described above (`plugin-dir-rule`). Whether another plugin layout loads rules was not
  established.
- `--help` lists no option that selects an agent. A project subagent (`.cursor/agents/<name>.md`)
  named as `/parrot` in the prompt ran as a subagent of the main session, not as the session: a
  `taskToolCall` (`args.subagentType.custom.name`, `args.prompt`; `result.success` with
  `conversationSteps`, `agentId`, `durationMs`), after a `getMcpToolsToolCall` that looked the
  `Task` tool up (`subagent`). The subagent's own messages are not lines of the stream.

## Redactions

The project directory became `/work` and the capture directory `/capture`. Nothing else was
edited: ids, timestamps and event order are the CLI's.
