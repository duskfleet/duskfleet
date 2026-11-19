# Codex CLI fixtures

Real runs of **codex-cli 0.167.1** on macOS, captured on 2026-11-19 for the Codex harness
(issue #50). They are the contract the adapter's parser is written against; tests replay them
through a fake CLI and never launch the real one.

Every run was made in a scratch git repository holding a `README.md`, logged in with a ChatGPT
account (`codex login status`: "Logged in using ChatGPT"), on the CLI's default model: the stream
never names the model, and no run reports a cost.

## Files

`<name>.jsonl` is stdout (`codex exec --json`), `<name>.stderr` stderr when it held more than the
line described under "What the runs show".

Common flags, left out of the table: `codex exec --json --ignore-user-config
-c sandbox_workspace_write.network_access=false -c model_reasoning_effort="low"`. Unless the
table says otherwise the prompt is the last argument and stdin is `/dev/null`.

| Fixture            | Extra flags                                                          | Prompt                                   | Exit |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------- | ---- |
| `edit`             | `-s workspace-write`                                                 | create `hello.txt`                       | 0    |
| `shell`            | `-s workspace-write`                                                 | run `ls -la .`                           | 0    |
| `readonly-write`   | `-s read-only`                                                       | run `touch marker.txt .`                 | 0    |
| `network-blocked`  | `-s workspace-write`                                                 | run `curl` against `https://example.com` | 0    |
| `failed-model`     | `-s workspace-write -m no-such-model`                                | "Say hi"                                 | 1    |
| `resume`           | `codex exec resume --json --ignore-user-config <thread of edit>`     | "what did you do earlier?"               | 0    |
| `resume-unknown`   | `codex exec resume --json --ignore-user-config <unknown uuid>`       | "Say hi"                                 | 1    |
| `stdin`            | `-s read-only -`: the prompt is piped on stdin                       | "Reply with exactly: stdin works"        | 0    |
| `killed`           | `-s read-only`; SIGTERM after 6 s                                    | a 3000 word essay                        | 143  |
| `codex-home-patch` | `-s workspace-write`, no `--ignore-user-config`, env `CODEX_HOME=<dir>` | add a line to `hello.txt` with the patch tool | 0 |

`<dir>` of `codex-home-patch` was an empty directory holding only `auth.json`, a symbolic link to
the user's `~/.codex/auth.json`. `resume-unknown` printed nothing on stdout.

## What the runs show

**Stream**

- One JSON object per line. A run is `thread.started` (`thread_id`, the session id), then
  `turn.started`, then items, then `turn.completed` with `usage` (`input_tokens`,
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`).
  `turn.completed` is the last line of a run that ended on its own: there is a terminal event.
- Items arrive as `item.started` / `item.completed` pairs with the same `item.id`. Types seen:
  `agent_message` (`text`; only `item.completed`), `command_execution` (`command`,
  `aggregated_output`, `exit_code`, `status`: `in_progress`, `completed` or `failed`),
  `file_change` (`changes[]` of `{ path, kind }`, `status`) and `error` (`message`).
- The last `agent_message` of the turn is the final text.
- A shell command is recorded as the shell that ran it (`/bin/zsh -lc '<command>'`), and a failed
  command is an item with `status: "failed"` and its exit code, not a failed run.
- A file written through a shell redirect is a `command_execution` only (`edit`); a file written
  with the patch tool is a `file_change` with an absolute path (`codex-home-patch`).
- `input_tokens` includes the cached ones (`cached_input_tokens` is a part of it, not an addition).

**Sandbox**

- `-s read-only`: the write fails inside the command with `Operation not permitted`
  (`readonly-write`). The item is `failed` with exit code 1, the run exits 0, and nothing in the
  stream says the sandbox was the cause: the only trace is the command's own output.
- `sandbox_workspace_write.network_access=false`: the request fails inside the command with
  `curl: (6) Could not resolve host` (`network-blocked`). Same shape: a failed item, exit 0, no
  marker.
- No run here shows an approval request: `codex exec` did not ask for one in any of them.

**Failures**

- An unknown model: an `error` item, then a top-level `error` event and `turn.failed` with
  `error.message`, exit code 1 (`failed-model`). There is no `turn.completed`.
- Resuming an unknown session: nothing on stdout, one line on stderr
  (`Error: thread/resume: thread/resume failed: no rollout found for thread id ...`), exit code 1.
- SIGTERM: the stream stops after `turn.started`, exit code 143, no terminal event (`killed`).

**Sessions and environment**

- `codex exec resume <thread_id> "<prompt>"` continues the session and reports the same
  `thread_id` (`resume`). `codex exec resume --help` lists no `-s` / `--sandbox` option; the run
  here passed none.
- With a prompt argument and a stdin that is not a terminal, stderr carries one line,
  `Reading additional input from stdin...`, in every run (the help says piped stdin is appended to
  the prompt as a `<stdin>` block). It is not an error. With `-` the prompt itself comes from stdin.
- `CODEX_HOME=<dir>` with only a linked `auth.json` is enough to run: the CLI created its own
  `config.toml`, session store and SQLite files in that directory and left the user's
  `~/.codex` alone.
- `--ignore-user-config` skips the user's `config.toml` (model, `notify` program, trusted
  projects); authentication still comes from `CODEX_HOME`.
- Nothing in `codex --help` or `codex exec --help` loads an agent definition from a project
  folder; `codex agents` opens a session browser. Whether a project can define agents some other
  way was not established.

## Redactions

Paths under the capture directory became `/work` and the account name in `ls` output became `me`.
Nothing else was edited: ids, timestamps inside command output and event order are the CLI's.
