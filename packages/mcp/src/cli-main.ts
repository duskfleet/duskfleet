import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Small local CLI. Same orchestration layer as the MCP server, useful for
 * testing without an MCP client.
 *
 *   duskfleet agents
 *   duskfleet agents create <id> [--model <m>] [--budget <usd>] [...] [--force] -- "<system prompt>"
 *   duskfleet projects
 *   duskfleet run --project <id or path> [--agent <id>] [--model <m>] [--no-wait] -- "<prompt>"
 *   duskfleet runs [--status <s>] [--limit <n>]
 *   duskfleet run-info <run_id> [--events]
 *   duskfleet repair-subagents # backfill subagent rows of finished runs from their logs
 *   duskfleet schedules
 *   duskfleet schedules run-now <id or name>   # stamp run_requested_at; the lease holder fires it next tick
 *   duskfleet budgets [set <global | agent <id> | project <id>> --amount <usd> [--warn <pct>] [--no-hard-stop] | delete <id>]
 *   duskfleet tools           # MCP tool catalogue (names, descriptions, input schemas)
 *   duskfleet dashboard [--port <n>] [--no-open] [--no-install]   # install @duskfleet/web on demand, start it
 *   duskfleet serve            # long-running scheduler process (what the service runs)
 *   duskfleet install-service [--print]   # register `serve` with launchd / systemd --user / Task Scheduler
 *   duskfleet uninstall-service
 *   duskfleet mcp register --target claude-code|claude-desktop [--dry-run] [--yes]   # preview, backup, write
 *   duskfleet mcp status       # which Claude hosts have a duskfleet entry, and what it runs
 *   duskfleet doctor         # also reports the service and who holds the scheduler lease
 *   duskfleet doctor --probe   # plus one real hello run on haiku (costs cents): auth, blocking hooks
 *   duskfleet --version        # handled in cli.ts, before the Node version check
 */
import { parseArgs } from "node:util";
import {
  assertAgentIdFree,
  type BudgetInput,
  ConfigNotFoundError,
  createAgentFromFields,
  type DataSource,
  effectivePath,
  findRepoRoot,
  loadConfig,
  parseHolder,
  pathDefaulted,
  RUN_STATUSES,
  type RunStatus,
  resolveConfigDir,
  subagentView,
  summarizeRun,
} from "@duskfleet/core";
import { bootstrap } from "./bootstrap.js";
import { ensureWeb, findWeb, parsePort, startDashboard } from "./dashboard.js";
import {
  applyDesktop,
  desktopConfigPath,
  MCP_TARGETS,
  type McpTarget,
  mcpStatus,
  planClaudeCode,
  planDesktop,
  runClaudeCodeAdd,
  serverEntry,
} from "./mcp-register.js";
import { PROBE_COST_NOTE, type ProbeReport, probeNotRun, runProbe } from "./probe.js";
import {
  exportedDataDir,
  installService,
  renderService,
  type ServiceTarget,
  serviceDirs,
  serviceStatus,
  uninstallService,
} from "./service.js";
import { buildToolCatalog } from "./tools-catalog.js";
import { packageVersion } from "./version.js";

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Last line of the usage, and of any command that fails because no config was found. */
const INIT_HINT = "First time here? Run: npx duskfleet init";

/** Usage on stderr with exit 2 (a wrong invocation), or on stdout with exit 0 when asked for (`--help`). */
function usage(asked = false): never {
  (asked ? process.stdout : process.stderr).write(
    [
      "Duskfleet - A fleet of agents for your own machine.",
      "",
      "Usage:",
      "  duskfleet agents",
      "  duskfleet agents create <id> [--model <m>] [--budget <usd>] [--permission-mode <mode>]",
      "                          [--allowed-tools <a,b>] [--disallowed-tools <a,b>] [--timeout <minutes>]",
      '                          [--description <text>] [--force] (-- "<system prompt>" | --prompt-file <file>)',
      "  duskfleet projects",
      '  duskfleet run --project <id or path> [--agent <id>] [--model <m>] [--no-wait] -- "<prompt>"',
      "  duskfleet runs [--status <status>] [--limit <n>]",
      "  duskfleet run-info <run_id> [--events]",
      "  duskfleet repair-subagents",
      "  duskfleet schedules",
      "  duskfleet schedules run-now <schedule id or name>",
      "  duskfleet budgets",
      "  duskfleet budgets set <global | agent <id> | project <id>> --amount <usd> [--warn <percent>] [--no-hard-stop]",
      "  duskfleet budgets delete <budget id>",
      "  duskfleet tools",
      "  duskfleet dashboard [--port 4777] [--no-open] [--no-install]",
      "  duskfleet serve",
      "  duskfleet install-service [--print]",
      "  duskfleet uninstall-service",
      "  duskfleet mcp register --target claude-code|claude-desktop [--dry-run] [--yes]",
      "  duskfleet mcp status",
      "  duskfleet doctor [--probe]",
      "  duskfleet --help",
      "  duskfleet --version",
      "",
      INIT_HINT,
      "",
    ].join("\n"),
  );
  process.exit(asked ? 0 : 2);
}

/**
 * Defaults of `agents create` when a flag is not given: what makes the README Quick start safe
 * with only `--model haiku` (a small budget, no prompts, file tools plus the common test runners).
 */
const AGENT_CREATE_DEFAULTS = {
  maxBudgetUsd: 0.5,
  permissionMode: "dontAsk",
  timeoutMinutes: 10,
  allowedTools: [
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "Bash(npm test:*)",
    "Bash(npm run test:*)",
    "Bash(npx vitest:*)",
    "Bash(npx jest:*)",
    "Bash(pytest:*)",
    "Bash(python -m pytest:*)",
    "Bash(cargo test:*)",
    "Bash(go test:*)",
    "Bash(make test:*)",
  ],
} as const;

function csv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function numberFlag(name: string, value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${value}"`);
  return n;
}

/** `agents create <id> [flags] -- "<system prompt>"` to the raw fields of a kind `own` agent. */
function parseAgentCreate(args: string[]): { id: string; fields: Record<string, unknown>; force: boolean } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m" },
      budget: { type: "string" },
      "permission-mode": { type: "string" },
      "allowed-tools": { type: "string" },
      "disallowed-tools": { type: "string" },
      timeout: { type: "string" },
      description: { type: "string" },
      "prompt-file": { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const [id, ...words] = positionals;
  if (!id) usage();
  // Same rule as create_agent: bypassPermissions stays a hand-edited, config-gated choice.
  if (values["permission-mode"] === "bypassPermissions") {
    throw new Error("--permission-mode bypassPermissions cannot be set here; edit the agent file by hand");
  }
  const inline = words.join(" ").trim();
  if (inline && values["prompt-file"])
    throw new Error("give the system prompt after -- or with --prompt-file, not both");
  const systemPrompt = values["prompt-file"] ? readFileSync(values["prompt-file"], "utf8") : inline;
  if (!systemPrompt.trim()) {
    throw new Error(
      'agents create needs a system prompt: the persona of the agent, after -- ("...") or in a file with --prompt-file',
    );
  }
  const fields: Record<string, unknown> = {
    id,
    description: values.description ?? "",
    permission_mode: values["permission-mode"] ?? AGENT_CREATE_DEFAULTS.permissionMode,
    allowed_tools:
      values["allowed-tools"] !== undefined ? csv(values["allowed-tools"]) : [...AGENT_CREATE_DEFAULTS.allowedTools],
    timeout_minutes:
      values.timeout !== undefined ? numberFlag("timeout", values.timeout) : AGENT_CREATE_DEFAULTS.timeoutMinutes,
    max_budget_usd:
      values.budget !== undefined ? numberFlag("budget", values.budget) : AGENT_CREATE_DEFAULTS.maxBudgetUsd,
    system_prompt: systemPrompt,
  };
  if (values.model) fields["model"] = values.model;
  if (values["disallowed-tools"] !== undefined) fields["disallowed_tools"] = csv(values["disallowed-tools"]);
  return { id, fields, force: values.force };
}

/** What the service runs: this node, this dist/cli.js, this repo (or config), the resolved claude binary. */
function serviceTarget(
  claudeBin: string | null,
  dataDir: string,
  configDir: string,
  dataSource: DataSource,
): ServiceTarget {
  // The bin is dist/cli.js (the Node version check); this module sits next to it.
  const cliEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  // An installed package has no repo root above its cli.js: the unit then carries the config dir.
  const dirs = serviceDirs(findRepoRoot(cliEntry), configDir);
  return {
    platform: process.platform,
    repoRoot: dirs.repoRoot,
    configDir: dirs.configDir,
    // DUSKFLEET_DATA / XDG_* live only in this shell: the unit carries the resolved directory,
    // or the service opens another database.
    dataDir: exportedDataDir(dataDir, dataSource, configDir),
    nodeBin: process.execPath,
    cliEntry,
    logPath: path.join(dataDir, "logs", "serve.log"),
    claudeBin,
  };
}

/** Ask y/N on a terminal; anything but a terminal (a script, CI) needs --yes instead. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write("not a terminal: pass --yes to apply the change without asking (nothing was changed)\n");
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * `mcp register`: print exactly what changes (the `claude mcp add` command, or the diff of the
 * Claude Desktop entry), stop there on --dry-run, else confirm (or --yes), back up, write.
 * Returns the exit code.
 */
async function mcpRegister(
  app: Awaited<ReturnType<typeof bootstrap>>,
  target: McpTarget,
  dryRun: boolean,
  yes: boolean,
): Promise<number> {
  // dist/index.js sits next to this module; the config is exported only when the server would
  // not find it by walking up from there (same rule as the service unit).
  const entryFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const { entry, form } = serverEntry({
    nodeBin: process.execPath,
    serverEntry: entryFile,
    claudeBin: app.executor.binary,
    configDir: serviceDirs(findRepoRoot(entryFile), app.config.configDir).configDir,
    // A GUI host does not see this shell's DUSKFLEET_DATA / XDG_* variables either.
    dataDir: exportedDataDir(app.config.dataDir, app.config.dataSource, app.config.configDir),
    version: packageVersion(),
  });
  const out = (s: string) => process.stdout.write(`${s}\n`);
  out(
    form === "npx"
      ? `server command: npx, pinned to duskfleet@${packageVersion()} (this CLI runs from npx's temporary cache)`
      : "server command: node + the absolute path of this install's MCP server",
  );

  if (target === "claude-code") {
    const plan = planClaudeCode(entry);
    if (plan.upToDate) {
      out(`Claude Code already has "duskfleet" with this command; nothing to do.`);
      return 0;
    }
    if (plan.conflict) {
      const envList = Object.entries(plan.conflict.env).map(([k, v]) => `${k}=${v}`);
      process.stderr.write(
        `Claude Code already has a user-scope "duskfleet" entry running ${[plan.conflict.command, ...plan.conflict.args].join(" ")} (env: ${envList.length ? envList.join(" ") : "none"}), which differs from this one.\nRemove it first (claude mcp remove duskfleet), then run this again.\n`,
      );
      return 1;
    }
    out(`will run:\n  ${plan.display}`);
    if (dryRun) return 0;
    if (!yes && !(await confirm("Run it?"))) return 1;
    return runClaudeCodeAdd(app.executor.binary ?? "claude", plan.args);
  }

  const plan = planDesktop(desktopConfigPath(), entry);
  if (!plan.changed) {
    out(`${plan.path} already has this "duskfleet" entry; nothing to do.`);
    return 0;
  }
  out(plan.diff);
  if (dryRun) {
    out("dry run: nothing was written");
    return 0;
  }
  if (!yes && !(await confirm(`Write ${plan.path}${plan.exists ? " (a .bak copy is made first)" : ""}?`))) return 1;
  const { backup } = applyDesktop(plan);
  if (backup) out(`backup: ${backup}`);
  out(`written: ${plan.path}\nRestart Claude Desktop to load the duskfleet tools.`);
  return 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();
  // Before bootstrap: help must work without a config (a fresh `npx duskfleet --help`).
  if (command === "--help" || command === "-h" || command === "help") usage(true);
  if (command === "tools") {
    print(await buildToolCatalog());
    return;
  }
  // Read-only and config-free: works before `init`.
  if (command === "mcp" && rest[0] === "status" && rest.length === 1) {
    print(mcpStatus());
    return;
  }
  // Needs the config (data and config paths), not the database: the dashboard opens it itself.
  if (command === "dashboard") {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: "string" },
        "no-open": { type: "boolean", default: false },
        "no-install": { type: "boolean", default: false },
      },
    });
    const port = parsePort(values.port);
    const config = loadConfig(resolveConfigDir(import.meta.url));
    const log = (line: string) => process.stderr.write(`duskfleet dashboard: ${line}\n`);
    const version = packageVersion();
    const entry = values["no-install"]
      ? findWeb(config.dataDir, version)
      : ensureWeb(config.dataDir, version, log).entry;
    process.exit(await startDashboard({ entry, port, configDir: config.configDir, open: !values["no-open"], log }));
  }

  const app = await bootstrap(import.meta.url, { role: command === "serve" ? "serve" : "cli" });
  const done = (code = 0) => {
    app.close();
    process.exit(code);
  };

  switch (command) {
    case "install-service": {
      const { values } = parseArgs({ args: rest, options: { print: { type: "boolean", default: false } } });
      const target = serviceTarget(
        app.executor.binary,
        app.config.dataDir,
        app.config.configDir,
        app.config.dataSource,
      );
      if (values.print) {
        const unit = renderService(target);
        process.stderr.write(`# ${unit.unitPath}\n`);
        process.stdout.write(unit.content);
        process.stderr.write(`\n# install: ${unit.installCommands.join(" && ")}\n`);
        return done();
      }
      const { unit, ran } = installService(target);
      const status = serviceStatus(process.platform);
      print({
        installed: true,
        platform: unit.platform,
        label: unit.label,
        unitPath: unit.unitPath,
        logPath: target.logPath,
        ran,
        status,
        notes: unit.notes,
      });
      return done(status.running === false ? 1 : 0);
    }
    case "uninstall-service": {
      const r = uninstallService(process.platform);
      print({ uninstalled: true, ...r });
      return done();
    }
    case "mcp": {
      const [sub, ...args] = rest;
      if (sub !== "register") usage();
      const { values } = parseArgs({
        args,
        options: {
          target: { type: "string" },
          "dry-run": { type: "boolean", default: false },
          yes: { type: "boolean", default: false },
        },
      });
      const target = values.target as McpTarget | undefined;
      if (!target || !MCP_TARGETS.includes(target)) {
        throw new Error(`mcp register needs --target ${MCP_TARGETS.join(" or ")}`);
      }
      return done(await mcpRegister(app, target, values["dry-run"], values.yes));
    }
    case "agents": {
      const [sub, ...args] = rest;
      if (sub === "create") {
        const { id, fields, force } = parseAgentCreate(args);
        const config = app.config;
        const existing = assertAgentIdFree(config, id, force, "--force", null);
        const agent = createAgentFromFields("own", fields, config, () => app.runs.reloadConfig());
        const { systemPrompt: _p, ...shown } = agent;
        process.stderr.write(
          `agent "${id}" written to ${agent.sourcePath}\nnext: duskfleet run --project <id or absolute path> --agent ${id} -- "<task>"\n`,
        );
        print({ created: true, overrode: existing?.source ?? null, agent: shown });
        return done();
      }
      if (sub) usage();
      const agents = [...app.config.agents.values()].map(({ systemPrompt: _p, ...a }) => a);
      if (agents.length === 0) {
        process.stderr.write(
          `no agents yet: Duskfleet ships none. Create your first one with\n  duskfleet agents create <id> --model haiku -- "<system prompt>"\n`,
        );
      }
      print(agents);
      return done();
    }
    case "projects": {
      print({ allowedProjectRoots: app.config.allowedProjectRoots, projects: [...app.config.projects.values()] });
      return done();
    }
    case "doctor": {
      const { values: doctorFlags } = parseArgs({
        args: rest,
        options: { probe: { type: "boolean", default: false } },
      });
      let version: string | null = null;
      let error: string | null = null;
      try {
        version = await app.executor.version();
      } catch (err) {
        error = String(err);
      }
      const service = serviceStatus(process.platform);
      const lease = app.scheduler.status().lease;
      const leaseLive = lease ? new Date(lease.expiresAt).getTime() > Date.now() : false;
      const holder = lease && leaseLive ? parseHolder(lease.holder) : null;
      const scheduler = {
        enabled: app.config.scheduler.enabled,
        ticking: leaseLive,
        holder: holder ? { role: holder.role, host: holder.host, pid: holder.pid, expiresAt: lease!.expiresAt } : null,
        service,
        advice: !app.config.scheduler.enabled
          ? "scheduler.enabled is false in duskfleet.yaml: nothing fires"
          : service.running
            ? null
            : service.supported
              ? `schedules fire only while an MCP host keeps the server alive${leaseLive ? "" : " (nothing is ticking right now)"}; run "duskfleet install-service" to run them unattended`
              : service.detail,
      };
      // Opt-in live run: the only part of doctor that costs money, so say so before spending it.
      let probe: ProbeReport | null = null;
      if (doctorFlags.probe && error) {
        process.stderr.write("doctor --probe skipped: claude --version failed, fix that first (nothing was spent)\n");
        probe = probeNotRun(
          "skipped",
          "claude --version failed",
          "the probe did not run because claude --version failed; fix the binary (see error) and probe again",
        );
      } else if (doctorFlags.probe) {
        process.stderr.write(`${PROBE_COST_NOTE}...\n`);
        try {
          probe = await runProbe(app.executor, app.config.claude);
          // Ctrl-C / kill: the paid child is cancelled and the temp dir gone; no report.
          if (probe.outcome === "interrupted") return done(130);
        } catch (err) {
          probe = probeNotRun(
            "error",
            String(err),
            "the probe could not run (see probe.error); this is a local problem, not a Claude result",
          );
        }
      }
      print({
        node: process.version,
        claudeBinary: app.executor.binary,
        claudeVersion: version,
        // What the claude lookup and every run use; defaulted = the inherited PATH was missing or
        // minimal (GUI-launched host) and the usual install directories were put in front.
        path: effectivePath(process.env["PATH"]),
        pathDefaulted: pathDefaulted(process.env["PATH"]),
        error,
        configDir: app.config.configDir,
        // env (DUSKFLEET_CONFIG) > repo (config/ found walking up) > user (user-level directory)
        configSource: app.location.source,
        configLookup: app.location.lookup,
        dataDir: app.config.dataDir,
        // env (DUSKFLEET_DATA) > config (data_dir, or ../data next to a repo config) > user
        dataSource: app.config.dataSource,
        agents: [...app.config.agents.keys()],
        scheduler,
        ...(doctorFlags.probe ? { probe } : {}),
      });
      return done(error || (probe && !probe.ok) ? 1 : 0);
    }
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          project: { type: "string", short: "p" },
          "project-id": { type: "string" },
          agent: { type: "string", short: "a" },
          model: { type: "string", short: "m" },
          "no-wait": { type: "boolean", default: false },
        },
      });
      const prompt = positionals.join(" ").trim();
      if (!prompt || (!values.project && !values["project-id"])) usage();

      const input: Parameters<typeof app.runs.startRun>[0] = { prompt };
      // --project takes a registered id or an absolute path (core decides which); --project-id is the explicit form.
      if (values.project) input.projectPath = values.project;
      if (values["project-id"]) input.projectId = values["project-id"];
      if (values.agent) input.agentId = values.agent;
      if (values.model) input.model = values.model;

      let run = await app.runs.startRun(input);
      process.stderr.write(`run ${run.id} started (session ${run.claudeSessionId})\nlog: ${run.logPath}\n`);
      if (!values["no-wait"]) {
        run = await app.runs.waitForRun(run.id, 24 * 60 * 60 * 1000);
      }
      print(run);
      return done(run.status === "completed" || run.status === "running" ? 0 : 1);
    }
    case "runs": {
      const { values } = parseArgs({
        args: rest,
        options: { status: { type: "string" }, limit: { type: "string" }, agent: { type: "string" } },
      });
      const filter: Parameters<typeof app.runs.listRuns>[0] = {};
      if (values.status) {
        if (!(RUN_STATUSES as readonly string[]).includes(values.status)) usage();
        filter.status = values.status as RunStatus;
      }
      if (values.limit) filter.limit = Number(values.limit);
      if (values.agent) filter.agentId = values.agent;
      print(app.runs.listRuns(filter).map(summarizeRun));
      return done();
    }
    case "schedules": {
      const [sub, target] = rest;
      if (sub === "run-now") {
        if (!target) usage();
        // Only stamps run_requested_at: the lease holder (normally the service) fires the
        // schedule on its next tick. Nothing is spawned here, so this is the command to call
        // from a git hook or any script that must return at once (`run --no-wait` would exit
        // before the run's stream is read).
        const schedule = app.scheduler.requestRun(target);
        if (!schedule) {
          process.stderr.write(`schedule not found: ${target}\n`);
          return done(1);
        }
        const lease = app.scheduler.status().lease;
        const leaseLive = lease ? new Date(lease.expiresAt).getTime() > Date.now() : false;
        process.stderr.write(
          leaseLive
            ? `schedule "${schedule.name}" requested; ${lease!.holder} fires it within ${app.config.scheduler.tickSeconds}s\n`
            : `schedule "${schedule.name}" requested, but nothing is ticking: it fires when a scheduler starts (duskfleet serve / install-service)\n`,
        );
        print(schedule);
        return done();
      }
      if (sub) usage();
      print({ scheduler: app.scheduler.status(), schedules: app.scheduler.listWithLastRun() });
      return done();
    }
    case "budgets": {
      const [sub, ...args] = rest;
      if (sub === "set") {
        const { values, positionals } = parseArgs({
          args,
          allowPositionals: true,
          options: {
            amount: { type: "string" },
            warn: { type: "string" },
            "no-hard-stop": { type: "boolean", default: false },
          },
        });
        const [scope, scopeId] = positionals;
        if (!scope || !values.amount) usage();
        const input: BudgetInput = { scope: scope as BudgetInput["scope"], amountUsd: Number(values.amount) };
        if (scopeId) input.scopeId = scopeId;
        if (values.warn) input.warnPercent = Number(values.warn);
        if (values["no-hard-stop"]) input.hardStop = false;
        print(app.runs.setBudget(input));
        return done();
      }
      if (sub === "delete") {
        if (!args[0]) usage();
        if (!app.runs.deleteBudget(args[0])) {
          process.stderr.write(`budget not found: ${args[0]}\n`);
          return done(1);
        }
        print({ deleted: true });
        return done();
      }
      if (sub) usage();
      print(app.runs.budgetStatuses());
      return done();
    }
    case "serve": {
      // Keeps the scheduler ticking without any MCP host. Safe next to the MCP server:
      // only the lease holder fires. Stop with SIGINT/SIGTERM.
      app.scheduler.start();
      process.stderr.write(
        `duskfleet serve: scheduler ticking every ${app.config.scheduler.tickSeconds}s (holder ${app.scheduler.status().holder}); Ctrl-C to stop\n`,
      );
      // The scheduler's own interval is unref'd (it must not keep the MCP server alive) and a
      // pending promise does not hold the event loop either, so without a ref'd handle this
      // process exited with 0 right after its first tick and launchd restarted it every 10 s
      // (it never held the lease long enough to fire anything). This handle is what keeps
      // `serve` alive until SIGINT/SIGTERM.
      const keepAlive = setInterval(() => {}, 60_000);
      const stop = () => {
        clearInterval(keepAlive);
        app.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {}); // run forever
      return;
    }
    case "run-info": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { events: { type: "boolean", default: false } },
      });
      const id = positionals[0];
      if (!id) usage();
      const run = app.runs.getRun(id);
      if (!run) {
        process.stderr.write(`run not found: ${id}\n`);
        return done(1);
      }
      const subagents = app.runs.agents(id).map((s) => subagentView(s)); // same names as get_run
      const diff = app.runs.diff(id); // same field as get_run
      print(values.events ? { ...run, diff, subagents, events: app.runs.events(id) } : { ...run, diff, subagents });
      return done();
    }
    case "repair-subagents": {
      // One-shot backfill of subagent rows recorded by an older parser, from each finished run's log.
      print(await app.runs.repairSubagents());
      return done();
    }
    default:
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof ConfigNotFoundError) process.stderr.write(`${INIT_HINT}\n`);
  process.exit(1);
});
