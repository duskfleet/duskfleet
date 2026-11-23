# GitHub Copilot CLI fixtures

Real runs of **GitHub Copilot CLI 1.0.112** on macOS, captured on 2026-11-17 for the Copilot
harness (issue #446). They are the contract the adapter's parser is written against; tests replay
them through `fake-copilot.js` and never launch the real CLI.

Every run used `claude-haiku-4.5` in a scratch git repository holding a `README.md` (and, from
`instructions-untrusted` on, an `AGENTS.md`). The account is on premium-request billing and is
managed by an organization whose policy disables third-party MCP servers.

## Files

`<name>.jsonl` is stdout (`--output-format json`), `<name>.usage.json` the file written by
`--usage-output-file`, `<name>.stderr` stderr when it was not empty.

Common flags, left out of the table: `--output-format json --no-ask-user --no-auto-update
--disable-builtin-mcps --max-ai-credits 30 --usage-output-file <name>.usage.json
--model claude-haiku-4.5 --session-id <uuid>`.

| Fixture                        | Extra flags                                             | Prompt                            | Exit | Premium requests |
| ------------------------------ | ------------------------------------------------------- | --------------------------------- | ---- | ---------------- |
| `edit`                         | `--allow-tool write`                                    | create `hello.txt`                | 0    | 0.33             |
| `shell`                        | `--allow-tool 'shell(ls)'`                              | run `ls -la .`                    | 0    | 0.33             |
| `denied`                       | none                                                    | run `touch marker.txt`            | 0    | 0.33             |
| `failed-model`                 | `--model no-such-model`                                 | "Say hi"                          | 1    | 0                |
| `resume`                       | `--resume=<session of edit>`, no `--session-id`         | "what did you do earlier?"        | 0    | 0.33             |
| `resume-unknown`               | `--resume=<unknown uuid>`, no `--session-id`            | "Say hi"                          | 1    | 0                |
| `stdin`                        | no `-p`: the prompt is piped on stdin                   | "Reply with exactly: stdin works" | 0    | 0.33             |
| `agent`                        | `--add-dir <dir> --agent pim`                           | "list every code word"            | 0    | 0.33             |
| `instructions-untrusted`       | env `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<dir>`            | "list every code word"            | 0    | 0.33             |
| `trust-folder-with-session-id` | `--trust-folder`                                        | same                              | 1    | 0                |
| `killed`                       | none; SIGTERM after 6 s                                 | a 3000 word essay                 | 143  | 0                |
| `sandbox-denied`               | `--sandbox --allow-tool 'shell(cat)'`                   | run `cat /etc/hosts`              | 0    | 0.33             |
| `sandbox-read`                 | `--sandbox --allow-tool 'shell(cat)' --allow-all-paths` | run `cat /etc/hosts`              | 0    | 0.33             |

`<dir>` of `agent` and `instructions-untrusted` held `AGENTS.md` (code word PLUM) and
`.github/agents/pim.agent.md` (frontmatter `name`, `description`; code word MEDLAR). The scratch
repository's own `AGENTS.md` held the code word QUINCE.

## What the runs show

**Shape of the stream**

- One JSON object per line: `type`, `data`, `id`, `timestamp`, `parentId`; `ephemeral: true` on the
  ones not saved in the session history (deltas, status).
- First line `session.start` (`data.sessionId`, `copilotVersion`, `selectedModel`, `context.cwd`);
  a resumed run starts with `session.resume` instead and has no `session.start`.
- **The last line is `{"type":"result", "sessionId", "exitCode", "usage": {premiumRequests,
  totalApiDurationMs, sessionDurationMs, codeChanges}}`**, and it has no `data` wrapper. It is
  there on success, on a failure after start-up (`failed-model`) and after SIGTERM (`killed`).
  The process exits right after it, with the same code.
- `--session-id <uuid>` is honoured: it is the `sessionId` of `session.start` and of `result`.
- The prompt can be piped on stdin without `-p` (`stdin`): same stream.

**Messages and tools**

- `assistant.message`: `data.content` (text), `data.toolRequests[]` (`toolCallId`, `name`,
  `arguments`), `data.model`. The final answer is the last one with a non-empty `content`.
  `assistant.message_delta`, `assistant.reasoning_delta` and `assistant.tool_call_delta` are
  streaming copies of the same content.
- A tool call is `tool.execution_start` (`toolCallId`, `toolName`, `arguments`) then
  `tool.execution_complete` (`success`, `result.content`, and for the shell tool
  `shellExecution.exitCode`). Tool names seen: `create`, `bash`. Shell output also arrives as
  `tool.shell_output` and `tool.execution_partial_result`.
- **A denial** (`denied`) is `tool.execution_complete` with `success: false` and
  `error: {code: "denied", message: "Permission denied because no interactive user response was
  available. ..."}`. The run goes on and exits 0.
- A path outside the working directory is denied the same way, before the command runs
  (`sandbox-denied`): the code is `denied` too, nothing tells the two apart.

**Failures**

- Unknown model: `session.error` (`errorType: "query"`, `message: "Execution failed: Model ... is
  not available."`), then `result` with `exitCode: 1`.
- Unknown session on `--resume`: **nothing on stdout**, a plain-text error on stderr
  (`Error: No session, task, or name matched '<id>'.`), exit 1.
- A flag conflict is the argument parser's error on stderr, exit 1, nothing on stdout:
  `--trust-folder` cannot be used with `--session-id`.
- SIGTERM: `session.info` (`infoType: "cancellation"`), `assistant.idle` with `aborted: true`,
  `result` with `exitCode: 143`.

**Usage and cost**

- No dollars anywhere. `result.usage.premiumRequests` and the usage file
  (`totalPremiumRequestCost`, `totalNanoAiu`, `modelMetrics.<model>.usage` with input, output,
  cache read, cache write and reasoning tokens).
- On a resumed session `result.usage` is **cumulative for the session** (`resume`: 0.66 after the
  0.33 of `edit`), not the cost of this run.

**Instructions and the persona**

- In an untrusted folder a `-p` run still loads the project's own `AGENTS.md`
  (`instructions-untrusted` answers QUINCE).
- `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` does **not** put that directory's `AGENTS.md` in the prompt
  (PLUM is missing from the same answer); `copilot instruction list` shows it as a nested source.
- `--add-dir <dir> --agent <name>` with `<dir>/.github/agents/<name>.agent.md` does deliver the
  agent's instructions (`agent` answers QUINCE and MEDLAR).

**Sandbox**

- `--sandbox` is accepted in `-p` although `copilot --help` does not list it (`copilot help
  sandbox` names it). The run gets an `instruction.update` saying it is sandboxed, and every
  `tool.execution_complete` carries `sandboxed: true`.
- With the default policy a sandboxed command can read system paths (`sandbox-read` prints
  `/etc/hosts`). No run here shows what a command blocked by the sandbox itself looks like.

**Environment**

- `session.mcp_servers_loaded` lists the user-level MCP servers next to the built-in one. Here
  all are `disabled`: the built-in by `--disable-builtin-mcps`, the others by the organization's
  policy, so whether user-level servers load in `-p` on an unmanaged account is not shown.
- User-level hooks run in `-p`, untrusted folder included: the `postToolUse` text at the end of
  `tool.execution_complete.data.result.content` (`[cost: ...]`) comes from a hook of the machine
  the fixtures were captured on, not from Copilot.

## Project agents (`link-*`)

Real runs of **GitHub Copilot CLI 1.0.114** on macOS, captured on 2026-11-23 for link agents on
Copilot (issue #466): the persona is an agent the project itself defines, selected with
`--agent <name>`. Same account, same common flags as above, in a scratch git repository holding
`README.md`, `AGENTS.md` (code word QUINCE) and these files under `.github/agents/`:

| Agent file             | Frontmatter besides `name`, `description`      | Body                 |
| ---------------------- | ---------------------------------------------- | -------------------- |
| `pim.agent.md`         | none                                           | code word MEDLAR     |
| `tooly.agent.md`       | `tools: ["execute", "read", "edit", "search"]` | "run the commands"   |
| `reader.agent.md`      | `tools: ["read"]`                              | "answer questions"   |
| `modeled.agent.md`     | `model: claude-haiku-4.5`                      | "answer briefly"     |
| `modeled-big.agent.md` | `model: claude-sonnet-5.5`                     | "answer briefly"     |

No run passes `--add-dir` for the project itself: the working directory is the project.

| Fixture                   | Flags besides the common ones                          | Prompt                                    | Exit | Premium requests |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------- | ---- | ---------------- |
| `link`                    | `--agent pim`                                          | "list every code word"                    | 0    | 0.33             |
| `link-unknown`            | `--agent nope`                                         | "Say hi"                                  | 1    | 0                |
| `link-add-dir`            | `--agent pim --add-dir <extra>`                        | "list every code word"                    | 0    | 0.33             |
| `link-shadowed`           | `--agent pim --add-dir <shadow>`                       | "list every code word"                    | 0    | 0.33             |
| `link-tools-declared`     | `--agent tooly`                                        | run `touch marker.txt`                    | 0    | 0.33             |
| `link-tools-narrow-shell` | `--agent reader --allow-tool 'shell(ls)'`              | run `ls -la .`, or say "NO SHELL TOOL"    | 0    | 0.33             |
| `link-model`              | `--agent modeled`, **no `--model`**                    | "Reply with exactly: ok"                  | 0    | 0.33             |
| `link-model-flag`         | `--agent modeled-big` (with `--model claude-haiku-4.5`) | "Reply with exactly: ok"                  | 0    | 0.33             |

`<extra>` held `AGENTS.md` (code word PLUM), `.github/copilot-instructions.md` (FIG) and
`.github/instructions/words.instructions.md` with `applyTo: "**"` (DAMSON). `<shadow>` held its
own `.github/agents/pim.agent.md` (code word SLOE).

**Finding the agent**

- `--agent <name>` loads `<cwd>/.github/agents/<name>.agent.md` in an untrusted folder, with no
  `--add-dir` and no `--trust-folder` (`link` answers QUINCE and MEDLAR).
- A name the project does not define ends before any model call: **nothing on stdout**, exit 1,
  and stderr names what exists (`link-unknown.stderr`: `No such agent: nope, available: modeled,
  pim, reader, tooly`). No session, no `result` line.
- The stream of a link run has no event naming the agent: `session.start` is the same as without
  `--agent`.

**Extra instructions next to a project agent**

- `--add-dir <extra>` adds nothing to the prompt: neither that directory's `AGENTS.md`, nor its
  `.github/copilot-instructions.md`, nor a `.github/instructions/*.instructions.md` (`link-add-dir`
  answers QUINCE and MEDLAR only).
- An agent of the same name in an added directory does not replace the project's: the project's
  file wins (`link-shadowed` answers MEDLAR, never SLOE).
- `--agent` is given once and there is no system prompt flag, so on 1.0.114 nothing but the prompt
  itself carries instructions written outside the project agent's file.

**Tools the agent file declares**

- `tools:` grants no permission. With shell and edit declared and no `--allow-tool`,
  `touch marker.txt` is denied like in `denied` (`link-tools-declared`, `error.code: "denied"`,
  the file is not created).
- `tools:` narrows what exists. With `tools: ["read"]` the model has no shell tool although
  `--allow-tool 'shell(ls)'` allows one (`link-tools-narrow-shell` answers "NO SHELL TOOL" and
  makes no tool call).
- So a run can do what the file declares **and** the rules allow: the file cannot widen the rules.
- Seen in `link-tools-declared`, not specific to agents: after the denial the model ran
  `ls -la marker.txt 2>/dev/null || echo "..."` and it executed with no allow rule
  (`success: true`). Copilot runs some read-only shell commands without one.

**Model**

- No `--model`, agent file with `model:`: the file's model runs. `session.start` has no
  `selectedModel`, then two `session.model_change` events: `source: "startup"` (the account
  default) and `source: "agent"` with `previousModel` (`link-model`).
- `--model` and a different `model:` in the file: the flag wins, `selectedModel` and every
  `assistant.message` carry the flag's model and there is no `session.model_change`
  (`link-model-flag`).

## What was changed after capture

In the `link-*` fixtures paths under the scratch repository became `/work` and other paths under
the capture directory became `/capture`; the rest is as described below.

Paths under the capture directory became `/work`, the account name in `ls` output became `me`,
the user-level MCP server names became `user-server-N`, and the encrypted reasoning blobs
(`reasoningOpaque`, `signature`) became `<opaque>`. The `.usage.json` files were reformatted by
Biome (white space only). Nothing else was edited: ids, timestamps and event order are the CLI's.
