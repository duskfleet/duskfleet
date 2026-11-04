# Your first scheduled run

From nothing to a scheduled run you can see on the dashboard, in about five minutes (not
counting the first download of the package). Every step gives the command, what you should see
(trimmed) and how long it takes. The [README Quick start](../README.md#quick-start) covers a
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
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and **logged in** for
  your user: `claude auth status` says so; `claude auth login` logs in.
- macOS or Linux ([platform support](../README.md#platform-support)).

Nothing to clone: the CLI comes from npm, only from the
[`duskfleet`](https://www.npmjs.com/package/duskfleet) package or the
[`duskfleet/duskfleet`](https://github.com/duskfleet/duskfleet) repository.

```bash
npx duskfleet init --yes
```

```text
[1/5] Node v24.x.y: ok
[2/5] Claude Code 2.x.y (/home/<you>/.local/bin/claude): logged in
[3/5] Config: created /home/<you>/.config/duskfleet/duskfleet.yaml
      Data directory: /home/<you>/.local/share/duskfleet
[4/5] MCP registration: skipped (later: duskfleet mcp register --target claude-code|claude-desktop)
[5/5] Done. Created: ...
```

A `not logged in` on line 2 does not stop `init`; it ends with the command to log in. Log in
before step 5. Without `--yes`, `init` asks the MCP question of step 4 itself and offers a
guided first run ([`init`](cli.md#init)).

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
npx duskfleet agents create fixer --model haiku --budget 0.25 -- "You fix the failing test in this project. Run the tests, read the failure, change the minimum code, run them again. No git, no installs."
```

```text
agent "fixer" written to /home/<you>/.local/share/duskfleet/agents/fixer.md
next: duskfleet run --project <id or path> --agent fixer -- "<task>"
```

The file is an ordinary agent ([Agents](agents.md)): `model: haiku`, `max_budget_usd: 0.25`, no
permission prompts (`dontAsk`), the file tools plus the common test commands such as `npm test`,
10 minutes. You can also write that file by hand, or ask Claude for it with `create_agent` once
step 5 has registered the MCP server. A `fixer` you created from the README already exists:
`agents create` refuses it unless you add `--force`.

## 5. A schedule, fired now (2 min)

Schedules are created over MCP (`create_schedule`), from a Claude Code or Claude Desktop chat.
Register the server in Claude Code once:

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

The answer shows the new schedule with its `nextRunAt` (tomorrow at 03:00 UTC). Leave Claude
Code. A cron a few minutes ahead works too, but you do not have to wait: ask the scheduler to
fire it now. Something must be ticking for that, so start `serve` in a second terminal and leave
it open:

```bash
npx duskfleet serve
```

```text
duskfleet serve: scheduler ticking every 30s (holder serve@<host>:<pid>); Ctrl-C to stop
```

Then, back in the first terminal:

```bash
npx duskfleet schedules run-now "fixer nightly"
```

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
calls, the agent's last message and, in a git repository, the diff. `npx duskfleet schedules`
shows the schedule with how its last run ended. In `~/duskfleet-scratch`, `npm test` now passes
and `sum.js` adds.

## 6. The dashboard (1 min)

```bash
npx duskfleet dashboard
```

The first time it installs the dashboard package, then opens http://localhost:4777. The
**Runs** view lists the run with its cost, timeline and tool calls; **Schedules** shows "fixer
nightly", its next fire and how the last run ended ([Dashboard](dashboard.md)).

A green run completed cleanly. An **amber** one completed but needs review: a tool was denied, the
budget ran out, the run made no tool call, or another reason listed on the run; it is never shown
as plain green. What each reason means and how to fix it:
[Needs review](dashboard.md#needs-review).

## 7. Keep it firing after the terminal closes (1 min)

`serve` in a terminal stops with the terminal. Register it as a per-user service instead (launchd
on macOS, a systemd user unit on Linux). The service needs a global install, not npx's temporary
cache. Stop the `serve` of step 5 (Ctrl-C) first, then:

```bash
npm i -g duskfleet
duskfleet install-service
duskfleet doctor
```

`doctor` now reports the service installed and running, and the scheduler lease held by
`serve@<host>:<pid>`: "fixer nightly" fires at 03:00 UTC without any terminal or Claude host
open. On macOS the unit keeps the Mac awake on AC power, because a sleeping Mac skips scheduled
runs ([who ticks](schedules.md#who-ticks)).

To clean up, remove the service and, if you like, the scratch project (ask Claude to
`delete_schedule` "fixer nightly" too):

```bash
duskfleet uninstall-service
rm -rf ~/duskfleet-scratch
```

## Next

- [Schedules](schedules.md): gates that skip a tick cheaply when there is no work, auto-pause,
  budgets, what happens when the agent is busy.
- [Agents](agents.md): link an agent your project already defines in `.claude/agents/`.
- [Security](security.md): set `allowed_project_roots` before you point agents at real projects.
- [Troubleshooting](troubleshooting.md): a run that failed, timed out or never started.
