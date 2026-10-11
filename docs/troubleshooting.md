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
- **Runs failed with "orphaned"**: DuskFleet was restarted while they were running. Resume the
  Claude session with the `resumeCommand` from `get_run` if you want to continue the work.
- **Two DuskFleet processes, schedules fire once**: that is the SQLite lease at work. The
  dashboard's Schedules page shows the holder.
- **New code is not picked up**: the MCP host keeps the server process alive. After
  `npm run build`, restart Claude Desktop or the Claude Code session. Config changes need no restart.
- **`npm install` fails on root-owned files in `~/.npm`**: use `npm install --cache "$TMPDIR/npm-cache"`.
