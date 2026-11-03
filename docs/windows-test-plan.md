# Windows test plan

Windows is an **experimental** platform ([platform support](../README.md#platform-support)):
the code paths exist (`install-service` renders a Task Scheduler logon task in
`packages/mcp/src/service.ts`), but the maintainers have not run them. This page is a checklist
for anyone with a Windows machine. Copy it into an issue, fill in the **Result** column
(`pass`, `fail` + what you saw, or `skipped`) and attach `data/logs/serve.log` and the output of
failing commands.

Fixing what the plan finds is out of scope here: open one issue per failure.

> [!WARNING]
> Step 5 makes one real run on `--model haiku`, which costs a few cents on your Claude account.
> Step 9 may make more if your test schedule fires several times: pause or delete it afterwards.

## Before you start

- Windows 10 or 11, a normal (non-administrator) user account.
- Run every command from PowerShell in the repository root unless the step says otherwise.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in for
  this user (`claude --version` answers, `claude` opens without asking to log in).
- A scratch project for the run, for example `C:\scratch\df-test` with one file and a failing
  test, or just a `README.md`. Do not point Duskfleet at a project you care about.
- Note your Windows version (`winver`), Node version and Claude Code version in the issue.

## Steps

| # | Step | Command | Expected result | It failed if | Result |
|---|---|---|---|---|---|
| 1 | Node 24 install | `node --version` | `v24.x` or newer. With an older Node, any Duskfleet command prints `Duskfleet needs Node 24 or newer; you have vX.Y.Z` and exits 1 | `node` is not found, or an older Node runs Duskfleet without that message | |
| 2 | Install dependencies | `npm install` | Exits 0; no native build step (Duskfleet has no native addons) | Non-zero exit, a `node-gyp` or compiler error | |
| 3 | Build | `npm run build` | Exits 0; `packages\mcp\dist\cli.js` and `packages\mcp\dist\index.js` exist | Non-zero exit, a TypeScript error, missing `dist` files | |
| 4 | Doctor | `npm run cli -- doctor` | JSON report: the `claude` binary is found with a version, config and data paths are Windows paths under the repo, `scheduler.service` says `not installed` | `claude` not found although `claude --version` works in the same shell, paths with mixed or doubled separators, an exception instead of a report | |
| 5 | A haiku run on a scratch project (costs cents) | `npm run cli -- run --project C:\scratch\df-test --model haiku -- "List the files in this project"` then `npm run cli -- runs --limit 1` | The run ends `completed`; `runs` lists it with a cost; `data\logs\<run_id>.jsonl` exists and ends with a `result` line | The run stays `running`, ends `failed`, the log is missing or has no `result` line, the CLI hangs after the answer | |
| 6 | Print the service unit | `npm run cli -- install-service --print` | Prints Task Scheduler XML for task `Duskfleet Scheduler`: a `LogonTrigger` for your user, `ExecutionTimeLimit` `PT0S`, `RestartOnFailure`, an `Exec` of `cmd.exe` running `node ... cli.js serve >> ...\data\logs\serve.log 2>&1`, and `WorkingDirectory` the repo. Nothing is registered yet | Paths in the XML are wrong (not absolute, wrong drive, broken quoting), or the task gets registered by `--print` | |
| 7 | Install the service | `npm run cli -- install-service` | Exits 0; the XML is written to `%LOCALAPPDATA%\Duskfleet\scheduler-task.xml`; `schtasks /Query /TN "Duskfleet Scheduler"` shows the task; `doctor` reports `scheduler.service` installed and running and the lease holder role `serve` | `schtasks /Create` or `/Run` fails (the CLI prints which), or `doctor` shows the task but no `serve` lease holder after 1 minute | |
| 8 | Task visible in Task Scheduler | Open `taskschd.msc`, Task Scheduler Library | Task `Duskfleet Scheduler` exists, runs as your user "only when user is logged on", trigger "At log on", status Running; `data\logs\serve.log` is growing or at least exists | The task is missing, runs as another user, or shows a last run result other than `0x41301` (running) / `0x0` | |
| 9 | A schedule fires after login | Create a schedule a couple of minutes ahead on the scratch project and a haiku agent (from Claude Desktop / Claude Code via the MCP tools, or the dashboard), sign out, sign back in, wait for the fire time, then `npm run cli -- schedules` and `npm run cli -- runs --limit 1` | Without any MCP host open, the schedule fires: its last outcome is `started` and a new run appears, started by `serve` | No run after the fire time; `serve.log` shows errors; the lease holder is not `serve` | |
| 10 | Restart after kill | Find the `node ... cli.js serve` process (`Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Select ProcessId,CommandLine`), then `Stop-Process -Id <pid>`; wait 2 minutes, then `npm run cli -- doctor` | Task Scheduler restarts the task within about a minute (`RestartOnFailure`, interval 1 minute); `doctor` shows a `serve` lease holder with a new pid | No `serve` process after 2 minutes; the task stays "Ready" until the next logon. Note it: a killed process may not count as a task failure | |
| 11 | Uninstall | `npm run cli -- uninstall-service` then `schtasks /Query /TN "Duskfleet Scheduler"` | The task is ended and deleted; the query reports that the task does not exist; `doctor` says `not installed` | The task is still listed, or a `serve` process keeps running | |
| 12 | Path with spaces | Clone (or copy) the repository into a folder with a space, for example `C:\dev tools\duskfleet`, repeat steps 3, 4, 6 and 7 there, then run step 11 | Build, doctor and the service work; the XML quotes every path | `cmd.exe` errors such as `'C:\dev' is not recognized`, a task that starts and exits at once | |
| 13 | Drive letters | Register a project on another drive (for example `D:\scratch\df-test`) in `data\projects.yaml` and use its id in `npm run cli -- run --project <id> --model haiku -- "List the files"` (costs cents) | The run starts with that directory as cwd; `allowed_project_roots` checks accept it when it is listed there and refuse it when it is not | A valid absolute `D:\` path is refused as relative, or a lower-case `d:\` vs `D:\` mismatch refuses a listed root | |
| 14 | `~` expansion in `projects.yaml` | Add a project with `path: ~/scratch/df-test` (and one with `~\scratch\df-test`) to `data\projects.yaml`, then `npm run cli -- projects` | Both expand to `%USERPROFILE%\scratch\df-test` | The path stays literal `~...`, or one of the two separators is not expanded | |
| 15 | `node:sqlite` WAL on NTFS | With `serve` running (step 7), start `npm run web`, open `http://localhost:4777`, start a run from the CLI and watch it in the dashboard | The dashboard shows the run while it is running; `data\duskfleet.db-wal` and `data\duskfleet.db-shm` exist next to `data\duskfleet.db`; no `database is locked` / `SQLITE_BUSY` error in `serve.log` or the CLI | `database is locked` errors, the dashboard never sees the run until the writer exits, WAL files missing | |

## Reporting

Open an issue titled `Windows test plan results` with the filled table, the versions noted
above and the relevant part of `data/logs/serve.log`. For each failing step, a separate issue
with the command, the output and what you expected makes it fixable.
