# Troubleshooting

- **`doctor` cannot find `claude`**: set `claude.binary` in `duskfleet.yaml` or `CLAUDE_BIN`.
  GUI-launched hosts (Claude Desktop) start with a minimal `PATH` and do not expand `~` in
  `claude_desktop_config.json` ("No executable file at ~/..."): use absolute paths.
- **A run never finishes although the agent already answered**: a user-level hook in
  `~/.claude/settings.json` (for example a `Stop` hook that shows a desktop notification) may be
  blocking in a headless context. Set `claude.setting_sources: [project, local]` so runs skip
  user-level settings, or make the hook non-blocking. Inspect `data/logs/<run_id>.jsonl`: if the
  last line is an `assistant` message with no `result` line, this is the cause.
- **A completed run is "needs review"**: it hit a permission denial or an allow-listed MCP
  server never mounted. Open the run detail: the denied calls are listed with the command or
  file, and `mcp.allowListedMissing` names the server. Fix the agent's `allowed_tools` (or
  `inherit_mcp`), not the prompt.
- **The agent cannot run tests or use Bash**: `permission_mode: acceptEdits` does not allow
  Bash. Add entries such as `Bash(npm test:*)` to `allowed_tools`. The target project's own
  `.claude/settings` allow-lists are ignored in unattended runs.
- **A `plan` agent does nothing**: `plan` blocks Bash, MCP and writes regardless of allow-lists.
  Use `dontAsk` with `disallowed_tools: [Edit, Write, NotebookEdit]` for read-only agents.
- **`bypassPermissions` rejected**: enable `claude.allow_bypass_permissions` deliberately; it maps
  to `--dangerously-skip-permissions`.
- **Runs failed with "orphaned: owning process ... is gone"**: the DuskFleet process that
  started them (named in the error) exited or crashed while they were running. Runs of a live
  process (another MCP server, `serve`) are never touched. Resume the Claude session with the
  `resumeCommand` from `get_run` if you want to continue the work.
- **Two DuskFleet processes, schedules fire once**: that is the SQLite lease at work. The
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
