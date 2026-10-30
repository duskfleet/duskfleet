# Run Claude Code on a schedule on your own machine

Claude Code runs headless with `claude -p`: give it a prompt, it works in the current directory
and exits. Put that in cron, launchd or a systemd timer and you have an agent on a schedule.
This guide shows the plain approach first, then the ways it goes wrong unattended, then what
[Duskfleet](../../README.md) does about each of them.

Real runs cost money. Every example uses `--model haiku` and `--max-budget-usd`; keep both
while you try things out.

## The plain approach

### One script for every scheduler

Schedulers start jobs with almost nothing: a minimal `PATH`, no shell profile, no terminal.
Put everything the job needs in one script and point the scheduler at it, so cron, launchd and
systemd all run the same thing. Save it as `~/bin/claude-nightly.sh` and `chmod +x` it:

```bash
#!/bin/bash
# Nightly Claude Code run on one project. Paths are placeholders: use your own.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

PROJECT="$HOME/projects/scratch"            # the project the agent works in
LOG_DIR="$HOME/.local/state/claude-nightly"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y%m%d-%H%M%S).log"

cd "$PROJECT" || exit 1

printf '%s' "Run the tests. If one fails, fix the minimum code and run them again. No git, no installs." |
  claude -p \
    --model haiku \
    --max-budget-usd 0.50 \
    --permission-mode dontAsk \
    --permission-prompts none \
    --allowedTools "Read,Grep,Glob,Edit,Bash(npm test:*)" \
    >"$LOG" 2>&1
status=$?

echo "exit $status" >>"$LOG"
exit "$status"
```

Why each flag (all of them are in the [verified list](../development.md#extending), "Claude CLI flags"):

| Flag | What it does here |
|---|---|
| `-p` | Non-interactive. With no prompt argument it reads the prompt from stdin, which keeps the prompt clear of `--allowedTools` (that option takes a list and would swallow a trailing prompt) |
| `--model haiku` | Cheapest model. Without it the run uses the Claude Code default |
| `--max-budget-usd 0.50` | Hard cost cap for the run |
| `--permission-mode dontAsk` + `--permission-prompts none` | Nobody is there to answer a prompt: anything that would prompt is denied instead of waiting forever |
| `--allowedTools` | What the run may do without asking. Everything else is denied |

Run the script once by hand from a terminal before you schedule it.

### cron (Linux, macOS)

`crontab -e`, then one line (02:30 every night):

```
30 2 * * * /home/you/bin/claude-nightly.sh
```

cron does not read your shell profile and does not expand `~`: use absolute paths. On macOS,
cron may need Full Disk Access (System Settings, Privacy & Security) to read projects under
your home folder, and Apple recommends launchd instead.

### launchd (macOS)

Save as `~/Library/LaunchAgents/com.example.claude-nightly.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.claude-nightly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/bin/claude-nightly.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/claude-nightly.out.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/claude-nightly.err.log</string>
</dict>
</plist>
```

```bash
plutil -lint ~/Library/LaunchAgents/com.example.claude-nightly.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.claude-nightly.plist
launchctl kickstart gui/$(id -u)/com.example.claude-nightly    # one run now, to try it
launchctl bootout gui/$(id -u)/com.example.claude-nightly      # remove it again
```

A LaunchAgent runs as you, in your login session, so it sees the same Claude Code login as
your terminal. Unlike cron, launchd runs a missed `StartCalendarInterval` job once when the
Mac wakes up.

### systemd user timer (Linux)

`~/.config/systemd/user/claude-nightly.service`:

```ini
[Unit]
Description=Nightly Claude Code run

[Service]
Type=oneshot
ExecStart=/home/you/bin/claude-nightly.sh
```

`~/.config/systemd/user/claude-nightly.timer`:

```ini
[Unit]
Description=Nightly Claude Code run

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-nightly.timer
systemctl --user start claude-nightly.service    # one run now, to try it
journalctl --user -u claude-nightly.service      # what it printed
```

`Persistent=true` runs a missed tick once after boot. A `oneshot` service is never started twice
at the same time by its timer.

## What goes wrong unattended

Each failure mode below: what you see, why, and the fix in the plain setup.

### `claude` not found, or not logged in

- **Symptom**: the log says `claude: command not found`, or the run exits at once with an
  authentication error, although the same command works in your terminal.
- **Cause**: the scheduler's `PATH` is minimal (launchd: `/usr/bin:/bin:/usr/sbin:/sbin`) and
  your shell profile, where Node or `claude` are added to `PATH`, is never read. Credentials can
  be missing the same way: a job started outside your login session (cron on macOS, a systemd
  unit after logout) may not reach the place your login is stored.
- **Fix**: set `PATH` in the script (as above) or call `claude` by its absolute path
  (`command -v claude` in a terminal tells you where it is). Use the scheduler's "run now"
  command to check the login from the scheduler itself, not from your terminal. For a job that
  must run outside your login session, `claude setup-token` creates a long-lived token; see
  Claude Code's [headless docs](https://code.claude.com/docs/en/headless) for how to pass it.

### Permission prompts nobody answers

- **Symptom**: the run hangs until something kills it, or ends with a short answer saying it
  was not allowed to run a command.
- **Cause**: a tool call that needs approval waits for a person by default. With
  `--permission-prompts none` it is denied instead, and the agent works around it or stops.
  Your project's `.claude/settings.json` allow-list is not used either: with
  `--permission-prompts none`, only the `--allowedTools` of the command count, and file tools
  are confined to the project directory.
- **Fix**: always pass `--permission-prompts none`, and list in `--allowedTools` everything the
  task needs (`Bash(npm test:*)`, not just `Bash`). A rule matches at a word boundary and a
  colon is not one: `Bash(npm run lint:*)` does not allow `npm run lint:fix`. Read the log after
  the first runs and add what was denied.

### Overlapping runs

- **Symptom**: two runs edit the same checkout at once; a slow run is still going when the
  next tick starts another.
- **Cause**: cron starts the job on every tick, whether the previous one finished or not.
- **Fix**: on Linux, wrap the job in [`flock -n`](https://man7.org/linux/man-pages/man1/flock.1.html),
  which gives up at once when the lock is held:

  ```
  30 * * * * flock -n /tmp/claude-nightly.lock /home/you/bin/claude-nightly.sh
  ```

  macOS has no `flock(1)` by default; a launchd job is not started again while it is still
  running, and a systemd `oneshot` neither. Give every run a time limit too
  (`timeout 30m claude -p ...` on Linux), so one stuck run does not hold the lock forever.

### Silent failures

- **Symptom**: nothing happened for a week and you find out by chance.
- **Cause**: nobody reads the exit status, and the output went nowhere (cron mails it to a
  local mailbox, if anything).
- **Fix**: write every run to its own log file and record the exit status (the script above
  does both), and check them. `--max-budget-usd` and a time limit make the bad cases end
  instead of running on; the exit status tells you a run failed, but a run that "succeeded"
  after a denied command still exits 0: read the log.

### The machine is asleep, or you are logged out

- **Symptom**: the nightly run never happened.
- **Cause**: a sleeping laptop runs nothing. cron skips the ticks it missed; launchd and
  `Persistent=true` timers run a missed job once on wake, at whatever time that is. A systemd
  user unit stops when you log out.
- **Fix**: schedule runs for when the machine is awake, or keep it awake (macOS: Battery /
  Energy settings, `pmset`). On Linux, `loginctl enable-linger $USER` keeps user units running
  when you are logged out.

## What Duskfleet does about each one

Duskfleet runs the same `claude -p` against a project on your disk, from cron schedules it
keeps in a local SQLite database, and records every run. It does not hide the failure modes
above; it handles or reports each of them. Duskfleet-specific fixes are in
[Troubleshooting](../troubleshooting.md).

| Failure mode | What Duskfleet does |
|---|---|
| `claude` not found, not logged in | `install-service` writes a per-user launchd / systemd unit from your real paths, with the resolved `claude` binary as `CLAUDE_BIN`, so the scheduler never depends on `PATH` ([`service.ts`](../../packages/mcp/src/service.ts), [Schedules: who ticks](../schedules.md#who-ticks)). The unit runs as you, so it sees your Claude Code login. `doctor` shows the binary and the effective `PATH`; `doctor --probe` makes one real haiku run (cents) to check the login ([CLI](../cli.md)) |
| Permission prompts | Every run is `--permission-prompts none`; each agent's `allowed_tools` live in its own file ([Agents: permissions in unattended runs](../agents.md#permissions-in-unattended-runs)). A completed run that hit a denial is **needs review** (amber), never green, and lists the denied calls ([Troubleshooting: permission denial](../troubleshooting.md#permission-denial), [Dashboard: needs review](../dashboard.md#needs-review)) |
| Overlapping runs | One run per project directory and one per agent by default; a tick that finds them busy is refused with a [`BusyError`](../../packages/core/src/orchestration/busy.ts) and recorded as `skipped_busy`, never queued. Daily caps and monthly budgets are checked the same way ([Schedules: policies](../schedules.md#policies)) |
| Silent failures | Every run is a row with status, cost, tokens, tool calls and denials, plus a JSONL log per run; schedule rows show how their last run ended, and the dashboard on localhost shows runs, schedules and needs-review reasons ([Dashboard](../dashboard.md), [How it works](../how-it-works.md)). Budget and timeout come from the agent's frontmatter ([Troubleshooting: budget exhausted or timed out](../troubleshooting.md#budget-exhausted-or-timed-out)) |
| Asleep or logged out | Nothing runs while the machine sleeps, and missed ticks are not caught up: the schedule fires once when next considered ([Schedules: policies](../schedules.md#policies)). The service starts at login and restarts if it dies; on Linux, `loginctl enable-linger` keeps it running when you are logged out ([Schedules: who ticks](../schedules.md#who-ticks)) |

To try it, follow the [Quick start](../../README.md#quick-start), then create a schedule
paused, fire it once with **Run now** and read the run on the dashboard before you enable it
([Schedules](../schedules.md)).
