#!/usr/bin/env node
/**
 * Small local CLI. Same orchestration layer as the MCP server, useful for
 * testing without an MCP client.
 *
 *   duskfleet agents
 *   duskfleet projects
 *   duskfleet run --project <id or path> [--agent <id>] [--model <m>] [--no-wait] -- "<prompt>"
 *   duskfleet runs [--status <s>] [--limit <n>]
 *   duskfleet run-info <run_id> [--events]
 *   duskfleet schedules
 *   duskfleet tools            # MCP tool catalogue (names, descriptions, input schemas)
 *   duskfleet serve            # long-running scheduler process (what the service runs)
 *   duskfleet install-service [--print]   # register `serve` with launchd / systemd --user / Task Scheduler
 *   duskfleet uninstall-service
 *   duskfleet doctor           # also reports the service and who holds the scheduler lease
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bootstrap } from "./bootstrap.js";
import { buildToolCatalog } from "./tools-catalog.js";
import { installService, renderService, serviceStatus, uninstallService, type ServiceTarget } from "./service.js";
import { findRepoRoot, parseHolder, summarizeRun } from "@duskfleet/core";
import { RUN_STATUSES, type RunStatus } from "@duskfleet/core";

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  duskfleet agents",
      "  duskfleet projects",
      '  duskfleet run --project <id or path> [--agent <id>] [--model <m>] [--no-wait] -- "<prompt>"',
      "  duskfleet runs [--status <status>] [--limit <n>]",
      "  duskfleet run-info <run_id> [--events]",
      "  duskfleet schedules",
      "  duskfleet tools",
      "  duskfleet serve",
      "  duskfleet install-service [--print]",
      "  duskfleet uninstall-service",
      "  duskfleet doctor",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

/** What the service runs: this node, this dist/cli.js, this repo, the resolved claude binary. */
function serviceTarget(claudeBin: string | null, dataDir: string): ServiceTarget {
  const cliEntry = fileURLToPath(import.meta.url);
  const repoRoot = findRepoRoot(cliEntry) ?? path.resolve(path.dirname(cliEntry), "..", "..", "..");
  return {
    platform: process.platform,
    repoRoot,
    nodeBin: process.execPath,
    cliEntry,
    logPath: path.join(dataDir, "logs", "serve.log"),
    claudeBin,
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();
  if (command === "tools") {
    print(await buildToolCatalog());
    return;
  }

  const app = await bootstrap(import.meta.url, { role: command === "serve" ? "serve" : "cli" });
  const done = (code = 0) => {
    app.close();
    process.exit(code);
  };

  switch (command) {
    case "install-service": {
      const { values } = parseArgs({ args: rest, options: { print: { type: "boolean", default: false } } });
      const target = serviceTarget(app.executor.binary, app.config.dataDir);
      if (values.print) {
        const unit = renderService(target);
        process.stderr.write(`# ${unit.unitPath}\n`);
        process.stdout.write(unit.content);
        process.stderr.write(`\n# install: ${unit.installCommands.join(" && ")}\n`);
        return done();
      }
      const { unit, ran } = installService(target);
      const status = serviceStatus(process.platform);
      print({ installed: true, platform: unit.platform, label: unit.label, unitPath: unit.unitPath, logPath: target.logPath, ran, status, notes: unit.notes });
      return done(status.running === false ? 1 : 0);
    }
    case "uninstall-service": {
      const r = uninstallService(process.platform);
      print({ uninstalled: true, ...r });
      return done();
    }
    case "agents": {
      print([...app.config.agents.values()].map(({ systemPrompt: _p, ...a }) => a));
      return done();
    }
    case "projects": {
      print({ allowedProjectRoots: app.config.allowedProjectRoots, projects: [...app.config.projects.values()] });
      return done();
    }
    case "doctor": {
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
      print({
        node: process.version,
        claudeBinary: app.executor.binary,
        claudeVersion: version,
        error,
        configDir: app.config.configDir,
        dataDir: app.config.dataDir,
        agents: [...app.config.agents.keys()],
        scheduler,
      });
      return done(error ? 1 : 0);
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
      print({ scheduler: app.scheduler.status(), schedules: app.scheduler.list() });
      return done();
    }
    case "serve": {
      // Keeps the scheduler ticking without any MCP host. Safe next to the MCP server:
      // only the lease holder fires. Stop with SIGINT/SIGTERM.
      app.scheduler.start();
      process.stderr.write(`duskfleet serve: scheduler ticking every ${app.config.scheduler.tickSeconds}s (holder ${app.scheduler.status().holder}); Ctrl-C to stop\n`);
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
      const subagents = app.runs.agents(id);
      print(values.events ? { ...run, subagents, events: app.runs.events(id) } : { ...run, subagents });
      return done();
    }
    default:
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
