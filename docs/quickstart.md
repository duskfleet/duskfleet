# Your first scheduled run

From nothing to a scheduled run you can see on the dashboard, in about ten minutes: a few minutes
of commands, plus one Claude chat and the first run (not counting the first download of the
package). Every step gives the command, what you should see (trimmed: often the last lines of
the output) and how long it takes. The [README Quick start](../README.md#quick-start) covers a
single run by hand; this page goes one step further, to a schedule and the service that fires
it.

> [!WARNING]
> Step 5 starts one real run. On `haiku` it costs a few cents, and the agent below caps it at
> $0.25. An agent without a `model` uses the Claude Code default, which can cost 100 times
> more: keep `--model haiku` while you try things out.

Paths below are the Linux and macOS defaults (`~/.config/duskfleet`, `~/.local/share/duskfleet`);
`doctor` prints the ones in use ([where config and data live](configuration.md#where-config-and-data-live)).

## 1. Requirements and install (1 min)

- Node.js **24 or newer** (`node --version`).
- [Claude Code](https://code.claude.com/docs/en/overview) installed and **logged in** for
  your user: `claude auth status` says so; `claude auth login` logs in.
- macOS or Linux ([platform support](../README.md#platform-support)).

Nothing to clone: the CLI comes from npm. Install it only from the
[`duskfleet`](https://www.npmjs.com/package/duskfleet) npm package or the
[`duskfleet/duskfleet`](https://github.com/duskfleet/duskfleet) GitHub repository.

```bash
npx duskfleet init --yes
```

```text
[1/5] Node v24.x.y: ok
[2/5] Claude Code 2.x.y (Claude Code) (/home/<you>/.local/bin/claude): logged in
[3/5] Config: created /home/<you>/.config/duskfleet/duskfleet.yaml
      Data directory: /home/<you>/.local/share/duskfleet
[4/5] MCP registration: skipped (later: duskfleet mcp register --target claude-code|claude-desktop)
[5/5] Done. Created: ...
```

From 0.2.0, a `not logged in` on line 2 does not stop `init`; it writes the config and ends with
the command to log in. Duskfleet 0.1.0 stops at line 2 instead and writes nothing: run
`claude auth login`, then `init` again. Either way, log in before step 5. Without `--yes`, `init`
asks whether to register the MCP server (step 5 here) and offers a guided first run
([`init`](cli.md#init)).

## 2. Check the setup (30 s)

```bash
npx duskfleet doctor
```

A healthy output is JSON with the `claude` binary and its version found, `configSource: "user"`,
`dataSource: "user"`, the two directories of step 1, and a `scheduler` block that says nothing is
ticking yet. `npx duskfleet doctor --probe` adds one real hello run on haiku (a few cents, capped
at $0.05) and tells you, before step 5, whether the login works headless
([`doctor`](cli.md#doctor-logs-and-diffs)).

## 3. A scratch project (1 min)

A tiny repository with one failing test: `sum` subtracts.

```bash
mkdir -p ~/duskfleet-scratch/test
cd ~/duskfleet-scratch
echo '{ "name": "scratch", "private": true, "type": "module", "scripts": { "test": "node --test" } }' > package.json
echo 'export const sum = (a, b) => a - b;' > sum.js
cat > test/sum.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "../sum.js";

test("sum", () => assert.equal(sum(2, 3), 5));
EOF
npm test
```

`npm test` fails with `-1 !== 5`. Register the directory in the **private** project registry, the
`projects.yaml` of the data directory (never in a file you commit):

```bash
cat >> ~/.local/share/duskfleet/projects.yaml <<'EOF'
projects:
  scratch:
    path: ~/duskfleet-scratch
    description: Quick start scratch project
EOF
npx duskfleet projects
```

`projects` lists `scratch` with its absolute path. If the file already had a `projects:` key, add
the `scratch:` entry under it instead of appending a second one
([projects](configuration.md#projects-configprojectsyaml-optional)).

## 4. One agent on haiku (30 s)

```bash
npx duskfleet agents create fixer --model haiku --budget 0.25 -- "You fix the failing test in this project. Use the Read, Glob and Grep tools to look at files; use Bash only to run npm test. Run the tests, read the failure, change the minimum code, run them again. No git, no installs."
```

After the agent as JSON, the last two lines are:

```text
agent "fixer" written to /home/<you>/.local/share/duskfleet/agents/fixer.md
next: duskfleet run --project <id or path> --agent fixer -- "<task>"
```

The file is an ordinary agent ([Agents](agents.md)): `model: haiku`, `max_budget_usd: 0.25`, no
permission prompts (`dontAsk`), the file tools plus the common test commands such as `npm test`,
10 minutes. Any other shell command (`ls`, `cat`, `find`) is denied, which is why the prompt
sends the agent to the file tools. You can also write that file by hand, or ask Claude for it
with `create_agent` once step 5 has registered the MCP server. A `fixer` you created from the
README already exists, with the $0.50 default budget: `agents create` refuses it unless you add
`--force` (do, to get this prompt and the $0.25 cap).

## 5. A schedule, fired now (3 min)

Schedules are created over MCP (`create_schedule`), from a Claude Code or Claude Desktop chat:
the CLI lists and fires schedules but has no command to create one. Register the server in
Claude Code once:

```bash
npx duskfleet mcp register --target claude-code --yes
```

It prints the `claude mcp add duskfleet --scope user ...` command and runs it
([MCP server](mcp-server.md#register-with-a-claude-host)). Start `claude` in any directory and
ask, approving the `create_schedule` tool call when Claude Code asks:

```text
Create a Duskfleet schedule named "fixer nightly": agent fixer, project scratch,
prompt "Fix the failing test", cron 0 3 * * *, time zone UTC.
```

The tool call Claude Code asks you to approve should carry these arguments; check them before you
approve:

```text
create_schedule { "name": "fixer nightly", "agent_id": "fixer", "project_id": "scratch",
                  "prompt": "Fix the failing test", "cron": "0 3 * * *", "time_zone": "UTC" }
```

If Claude answers in prose instead of calling the tool, ask it to "use the duskfleet
create_schedule tool". The answer shows the new schedule with its `nextRunAt` (tomorrow at 03:00
UTC). Leave Claude Code. A cron a few minutes ahead works too, but you do not have to wait: ask the scheduler to
fire it now. Something must be ticking for that, so start `serve` in a second terminal and leave
it open:

```bash
npx duskfleet serve
```

After a few `[info]` log lines:

```text
duskfleet serve: scheduler ticking every 30s (holder serve@<host>:<pid>); Ctrl-C to stop
```

Then, back in the first terminal:

```bash
npx duskfleet schedules run-now "fixer nightly"
```

After the schedule as JSON:

```text
schedule "fixer nightly" requested; serve@<host>:<pid> fires it within 30s
```

Within 30 seconds the run starts, and haiku usually finishes it within a minute or two:

```bash
npx duskfleet runs --limit 1
npx duskfleet run-info <run_id>
```

`runs` lists the run with `agentId: "fixer"`, its `status` (`running`, then `completed`), cost
and `needsReview`; `run-info` with the `id` from it shows the run in full: model, tokens, tool
calls, the agent's last message and, in a git repository, the diff (the scratch project is not
one, so `diff` is `null`). `npx duskfleet schedules` shows the schedule with how its last run
ended. In `~/duskfleet-scratch`, `npm test` now passes and `sum.js` adds.

`needsReview: true` with `permission_denied` means the agent tried a shell command its
allow-list does not hold (`ls`, `cat`): it was refused, the run went on, and it usually still
fixes `sum.js`, but the agent may report that it could not run the tests. Run `npm test` in the
scratch folder yourself to check. `status: "failed"` with a login error means Claude Code is
not logged in for headless runs: `claude auth login`, then `run-now` again.

## 6. The dashboard (1 min)

```bash
npx duskfleet dashboard
```

The first time it installs the dashboard package, then opens http://localhost:4777. The
**Runs** view lists the run with its status, model, duration, turns and cost; click it for its
timeline and tool calls. **Schedules** shows "fixer nightly", its next fire and how the last run
ended ([Dashboard](dashboard.md)).

A green run completed cleanly. An **amber** one completed but needs review: a tool was denied, the
budget ran out, the run made no tool call, or another reason listed on the run; it is never shown
as plain green. A first run can be amber for the denied shell command of step 5. A **red** one
failed: the run page says why (not logged in, for example). What each reason means and how to
fix it: [Needs review](dashboard.md#needs-review).

## 7. Keep it firing after the terminal closes (1 min)

`serve` in a terminal stops with the terminal. Register it as a per-user service instead (launchd
on macOS, a systemd user unit on Linux). The service needs a global install, not npx's temporary
cache. Stop the `serve` of step 5 (Ctrl-C) first, then:

```bash
npm i -g duskfleet
duskfleet install-service
duskfleet doctor
```

If `npm i -g` fails with `EACCES` (a system Node whose global prefix is under `/usr`), do not use
`sudo`: install Node with a version manager (nvm, fnm) or set an npm prefix in your home.

`doctor` now reports the service installed and running, and the scheduler lease held by
`serve@<host>:<pid>`: "fixer nightly" fires at 03:00 UTC without any terminal or Claude host
open. On macOS the unit keeps the Mac awake on AC power, because a sleeping Mac skips scheduled
runs ([who ticks](schedules.md#who-ticks)). On Linux a user unit stops when you log out: run
`loginctl enable-linger $USER` so it keeps firing. If `install-service` says it cannot connect to
the user bus (containers, WSL without systemd, some SSH sessions), there is no systemd user
session to register with: keep `npx duskfleet serve` running in a terminal, tmux or your own
supervisor instead.

To clean up, remove the service and the scratch project:

```bash
duskfleet uninstall-service
rm -rf ~/duskfleet-scratch
```

Then delete "fixer nightly" with **Delete** on the dashboard's Schedules page (or ask Claude to
`delete_schedule` it), remove the `scratch:` entry from `~/.local/share/duskfleet/projects.yaml`
and `~/.local/share/duskfleet/agents/fixer.md`, and, if you are done with Duskfleet in Claude
Code, `claude mcp remove duskfleet`.

## Next

- [Schedules](schedules.md): gates that skip a tick cheaply when there is no work, auto-pause,
  budgets, what happens when the agent is busy.
- [Agents](agents.md): link an agent your project already defines in `.claude/agents/`.
- [Security](security.md): set `allowed_project_roots` before you point agents at real projects.
- [Troubleshooting](troubleshooting.md): a run that failed, timed out or never started.
