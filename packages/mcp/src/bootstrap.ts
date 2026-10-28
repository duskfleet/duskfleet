/**
 * Shared start-up for the MCP server and the CLI: load config, open the
 * database, build the executor and the RunManager.
 */

import type { DuskFleetConfig, SchedulerRole } from "@duskfleet/core";
import {
  ClaudeCodeExecutor,
  loadConfig,
  logger,
  openDatabase,
  processIdentity,
  RunManager,
  RunRepository,
  resolveConfigDir,
  ScheduleRepository,
  Scheduler,
} from "@duskfleet/core";

const log = logger("bootstrap");

export interface App {
  config: DuskFleetConfig;
  runs: RunManager;
  scheduler: Scheduler;
  executor: ClaudeCodeExecutor;
  close(): void;
}

export interface BootstrapOptions {
  /** How this process shows up as the scheduler lease holder (`serve`, `mcp`, `cli`). */
  role?: SchedulerRole;
}

export async function bootstrap(entryFileUrl: string, options: BootstrapOptions = {}): Promise<App> {
  const configDir = resolveConfigDir(entryFileUrl);
  const config = loadConfig(configDir);
  log.info("config loaded", { configDir, dataDir: config.dataDir, agents: [...config.agents.keys()] });

  const db = openDatabase(config.dataDir);
  const repo = new RunRepository(db);
  const executor = new ClaudeCodeExecutor({
    binary: config.claude.binary,
    strictMcpConfig: config.claude.strictMcpConfig,
    settingSources: config.claude.settingSources,
    allowBypassPermissions: config.claude.allowBypassPermissions,
    envPassthrough: config.claude.envPassthrough,
  });
  log.info("executor ready", { binary: executor.binary });

  // One identity for the runs this process owns and for the scheduler lease it may hold.
  const runs = new RunManager(config, repo, executor, { owner: processIdentity(options.role ?? "unknown") });
  runs.recoverOrphans();
  const scheduler = new Scheduler(new ScheduleRepository(db), runs, {
    tickMs: config.scheduler.tickSeconds * 1000,
    holder: runs.owner,
  });

  return {
    config,
    runs,
    scheduler,
    executor,
    close: () => {
      scheduler.stop();
      runs.shutdown();
      db.close();
    },
  };
}
