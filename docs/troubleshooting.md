# Troubleshooting

- **`Duskfleet needs Node 24 or newer; you have vX.Y.Z`** (exit code 1, from the CLI and the MCP
  server alike): Duskfleet uses the built-in `node:sqlite`, so it refuses older runtimes before
  loading anything. Switch to Node 24 (`nvm use` reads `.nvmrc`; `fnm` and others read
  `.node-version`) and run `npm run build` again. An MCP host started with an absolute `node`
  path keeps using that binary: point it at a Node 24 one.
- **`doctor` cannot find `claude`**: set `claude.binary` in `duskfleet.yaml` or `CLAUDE_BIN`.
  On macOS, GUI-launched hosts (Claude Desktop, launchd) start with a minimal `PATH` (only
  `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, or none): DuskFleet then puts
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` in front, to find `claude` and for every
  process it starts (runs, schedule gate commands, the git reads of a run's diff). `doctor`
  prints the effective `path` and `pathDefaulted: true` when that happened. On Linux and
  Windows the `PATH` is used as it is, even a minimal one. Such hosts also do not expand `~` in
  `claude_desktop_config.json` ("No executable file at ~/..."): use absolute paths.
- **Is `claude` logged in, will a hook block scheduled runs?** `npm run cli -- doctor --probe`
  makes one real hello run on haiku (cents) and says which of the two it hit
  ([CLI](cli.md)).
- **A run never finishes although the agent already answered**: a user-level hook in
  `~/.claude/settings.json` (for example a `Stop` hook that shows a desktop notification) may be
  blocking in a headless context. Set `claude.setting_sources: [project, local]` so runs skip
  user-level settings, or make the hook non-blocking. Inspect `data/logs/<run_id>.jsonl`: if the
  last line is an `assistant` message with no `result` line, this is the cause. Once the
  `result` line is out, Duskfleet does not wait: each run leads its own process group, and if the
  process (or anything it spawned that still holds its output, such as a hook) is alive 5 s
  later, the group gets SIGTERM, then SIGKILL after 5 s more. The run keeps the result's verdict
  and its events carry a note "still running 5 s after the result line". Keep
  `setting_sources` anyway: a hook that blocks before the result is not covered.
- **A completed run is "needs review"**: it hit a permission denial or an allow-listed MCP
  server never mounted. Open the run detail: the denied calls are listed with the command or
  file, and `mcp.allowListedMissing` names the server. Fix the agent's `allowed_tools` (or
  `inherit_mcp`), not the prompt. One exception: when the mounted list has no claude.ai
  connector at all, Claude Code came up without them and the allow-list is fine. Duskfleet
  restarts the process once when it sees that at init (note "restarted once" on the run); a run
  flagged anyway had no luck twice. Run it again.
- **The agent cannot run tests or use Bash**: `permission_mode: acceptEdits` does not allow
  Bash. Add entries such as `Bash(npm test:*)` to `allowed_tools`. The target project's own
  `.claude/settings` allow-lists are ignored in unattended runs.
- **An allow-listed command is still denied**: a prefix rule matches at a word boundary, and
  a colon is not one, so `Bash(npm run lint:*)` does not allow `npm run lint:fix`: list such
  scripts one by one (`Bash(npm run lint:fix)`). A variable in front (`FOO=1 npm test`) is a
  different command. Some shapes are refused whatever the rules say: an unquoted
  `@{upstream}`, a GraphQL fragment in `gh api graphql`, and a quoted argument with a line
  starting with `#` (pass a long PR body with `--body-file`). Verified with Claude Code 2.1.303.
- **A `plan` agent does nothing**: `plan` blocks Bash, MCP and writes regardless of allow-lists.
  Use `dontAsk` with `disallowed_tools: [Edit, Write, NotebookEdit]` for read-only agents.
- **`bypassPermissions` rejected**: enable `claude.allow_bypass_permissions` deliberately; it maps
  to `--dangerously-skip-permissions`.
- **Runs failed with "orphaned: owning process ... is gone"**: the Duskfleet process that
  started them (named in the error) exited or crashed while they were running. Runs of a live
  process (another MCP server, `serve`) are never touched. Resume the Claude session with the
  `resumeCommand` from `get_run` if you want to continue the work. "(unrecorded)" means the
  run was started by a build without run ownership; such a row is failed only once it is older
  than the longest configured timeout plus a minute, since it may come from a process still on
  that build (a `serve` not restarted after `npm run build`: re-run `install-service`).
- **A run stays `running` although nothing is running**: recovery only fails a run when its
  owner (`role@host:pid`) is provably gone. Two cases it cannot see: the owner's pid was
  reused by an unrelated live process, or the machine's hostname changed since the run
  started (macOS renames `Mac.local` to `Mac-2.local` on a name clash), so the owner looks like
  another host. Without `scheduler.enabled` (or with no process holding the lease) the
  periodic sweep does not run either; only the next start of a Duskfleet process recovers.
  Clean up by hand: stop the owning process if it is still alive, then mark the row failed in
  `data/duskfleet.db`, e.g.
  `sqlite3 data/duskfleet.db "UPDATE runs SET status='failed', error='manual cleanup' WHERE id='<run id>' AND status='running'"`.
- **`cancel_run` says the run is owned by another live Duskfleet process**: the claude child
  belongs to that process (another MCP server, or `serve`); cancel it there, or stop that process
  and the run is recovered as orphaned.
- **Two Duskfleet processes, schedules fire once**: that is the SQLite lease at work. The
  dashboard's Schedules page and `doctor` show the holder and its kind (`serve`, `mcp`).
- **"Ticking from an unknown process", Run now never fires, the service is running**: a
  `packages/mcp/dist/index.js` started before your last build (an MCP host keeps it alive)
  holds the lease with old code. Since the `serve` role preempts such holders, `install-service`
  (which restarts the service) fixes it; on a service older than that, kill the stale
  `index.js` processes or restart the hosts that spawned them.
- **Schedules stop when Claude Desktop closes**: only the MCP server was ticking. Install the
  service once with `npm run cli -- install-service`; `doctor` reports `scheduler.service`.
  If the service is running but nothing fires, read `data/logs/serve.log` (the service writes
  there, not to the terminal); a `claude` not found there means the unit's PATH / `CLAUDE_BIN`
  are stale, re-run `install-service`.
- **The service runs old code**: `install-service` again after every `npm run build` (it
  restarts the process), or `launchctl kickstart -k gui/$(id -u)/com.duskfleet.scheduler` /
  `systemctl --user restart duskfleet.service`.
- **New code is not picked up**: the MCP host keeps the server process alive. After
  `npm run build`, restart Claude Desktop or the Claude Code session. Config changes need no restart.
- **`npm install` fails on root-owned files in `~/.npm`**: use `npm install --cache "$TMPDIR/npm-cache"`.
