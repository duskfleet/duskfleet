/**
 * Shared start-up for the MCP server and the CLI: load config, open the
 * database, build the executor and the RunManager.
 */

import type { ConfigLocation, DuskFleetConfig, Executor, Run, SchedulerRole } from "@duskfleet/core";
import {
  ClaudeCodeExecutor,
  CodexExecutor,
  CopilotExecutor,
  HarnessRegistry,
  loadConfig,
  locateConfig,
  logger,
  openDatabase,
  processIdentity,
  RunManager,
  RunRepository,
  resolveCodexBinary,
  resolveCopilotBinary,
  ScheduleRepository,
  Scheduler,
} from "@duskfleet/core";

const log = logger("bootstrap");

export interface App {
  config: DuskFleetConfig;
  /** How the config directory was found (DUSKFLEET_CONFIG, repo-local, user-level). */
  location: ConfigLocation;
  runs: RunManager;
  scheduler: Scheduler;
  /**
   * The Claude Code adapter (setup, probe, service units); every harness is in `harnesses`. Null
   * when Claude Code is not found but another agent CLI is (#489): `claudeMissing` says why.
   */
  executor: ClaudeCodeExecutor | null;
  /** The Claude Code lookup error when `executor` is null. */
  claudeMissing: string | null;
  /** The executors runs can use, by harness name (`claude`); `doctor` reports each one. */
  harnesses: HarnessRegistry;
  /**
   * Runs the startup sweep failed as orphans (owner gone), as they were before: `running`
   * rows, and `pending` rows whose process died before the spawn. `doctor` reports them.
   */
  recoveredAtStartup: Run[];
  close(): void;
}

export interface BootstrapOptions {
  /** How this process shows up as the scheduler lease holder (`serve`, `mcp`, `cli`). */
  role?: SchedulerRole;
}

export async function bootstrap(entryFileUrl: string, options: BootstrapOptions = {}): Promise<App> {
  const location = locateConfig(entryFileUrl);
  const configDir = location.configDir;
  const config = loadConfig(configDir);
  log.info("config loaded", {
    configDir,
    configSource: location.source,
    dataDir: config.dataDir,
    agents: [...config.agents.keys()],
  });

  const db = openDatabase(config.dataDir);
  const repo = new RunRepository(db);
  let executor: ClaudeCodeExecutor | null = null;
  let claudeMissing: string | null = null;
  try {
    executor = new ClaudeCodeExecutor({
      binary: config.claude.binary,
      strictMcpConfig: config.claude.strictMcpConfig,
      settingSources: config.claude.settingSources,
      allowBypassPermissions: config.claude.allowBypassPermissions,
      envPassthrough: config.claude.envPassthrough,
    });
    log.info("executor ready", { binary: executor.binary });
  } catch (err) {
    claudeMissing = err instanceof Error ? err.message : String(err);
  }
  // One adapter per harness (issue #445); RunManager picks per run from the agent's `harness:`.
  // Copilot (#446) only when its binary resolves: an agent on it is otherwise refused as an
  // unregistered harness, and `doctor` says the CLI is not installed.
  const executors: Executor[] = executor ? [executor] : [];
  const copilotBinary = resolveCopilotBinary(config.copilot?.binary ?? null);
  if (copilotBinary) {
    executors.push(new CopilotExecutor({ binary: copilotBinary, envPassthrough: config.claude.envPassthrough }));
    log.info("copilot executor ready", { binary: copilotBinary });
  }
  // Codex (#50), same rule.
  const codexBinary = resolveCodexBinary(config.codex?.binary ?? null);
  if (codexBinary) {
    executors.push(new CodexExecutor({ binary: codexBinary, envPassthrough: config.claude.envPassthrough }));
    log.info("codex executor ready", { binary: codexBinary });
  }
  // Claude Code follows the same rule since #489 (any one agent CLI is enough), as long as another
  // CLI is there: with none at all, the Claude Code lookup error stays the start-up error.
  if (claudeMissing !== null) {
    if (executors.length === 0) throw new Error(claudeMissing);
    log.info("claude not found; running with the other harnesses", { error: claudeMissing });
  }
  const harnesses = new HarnessRegistry(executors);

  // One identity for the runs this process owns and for the scheduler lease it may hold.
  const runs = new RunManager(config, repo, harnesses, { owner: processIdentity(options.role ?? "unknown") });
  const recoveredAtStartup = runs.recoverOrphanRuns();
  const scheduler = new Scheduler(new ScheduleRepository(db), runs, {
    tickMs: config.scheduler.tickSeconds * 1000,
    holder: runs.owner,
  });

  return {
    config,
    location,
    runs,
    scheduler,
    executor,
    claudeMissing,
    harnesses,
    recoveredAtStartup,
    close: () => {
      scheduler.stop();
      runs.shutdown();
      db.close();
    },
  };
}
