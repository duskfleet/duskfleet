/**
 * @duskfleet/core public surface. Everything the MCP server, the CLI and the
 * web dashboard need is exported from here.
 */
export * from "./config/types.js";
export { loadConfig, loadAgents, resolveConfigDir, findRepoRoot, expandHome, isDirectory, splitFrontmatter } from "./config/loader.js";
export { upsertUserProject, readUserProjects, projectIdFromPath, PROJECT_ID_PATTERN, type UserProjectEntry } from "./config/project-files.js";
export {
  AGENT_ID_PATTERN,
  agentSpecSchema,
  agentFilePath,
  renderAgentMarkdown,
  writeAgentFile,
  deleteAgentFile,
  agentToSpec,
  listProjectAgents,
  projectAgentDefinitionHash,
  agentKind,
  assertAgentKind,
  type AgentKind,
  type AgentSpec,
  type ProjectAgentInfo,
} from "./config/agent-files.js";

export * from "./observability/run.js";

export { openDatabase } from "./storage/db.js";
export { RunRepository, NEEDS_REVIEW_SQL, type ListRunsFilter, type RunPatch } from "./storage/runs.js";

export * from "./execution/types.js";
export { ClaudeCodeExecutor, resolveClaudeBinary, type ClaudeCodeExecutorOptions } from "./execution/claude-code.js";
export { ingestLine, createStreamState, looksLikeContextExhaustion, type ParsedResult, type StreamState } from "./execution/stream-json.js";

export { RunManager, mcpToolPrefix, budgetPlan, mergeResults, WRAP_UP_PROMPT, type StartRunInput } from "./orchestration/run-manager.js";
export { summarizeToolInput } from "./orchestration/tool-summary.js";
export { validateProjectPath, ProjectValidationError } from "./orchestration/project-validation.js";
export { assertTransition, IllegalTransitionError } from "./orchestration/run-state.js";

export * from "./evals/types.js";
export * from "./scheduler/types.js";
export { parseCron, nextFire, describeCron, localParts, assertTimeZone, CronError, type CronSpec } from "./scheduler/cron.js";
export { Scheduler, type SchedulerOptions, type SchedulerStatus } from "./scheduler/scheduler.js";
export { attachLastRun, type ScheduleWithLastRun, type RunSummarySource } from "./scheduler/last-run.js";
export { createSchedule, updateSchedule, validateScheduleInput, nextRunAtFor, formatHolder, parseHolder, DEFAULT_TIME_ZONE, type SchedulerRole } from "./scheduler/crud.js";
export { ScheduleRepository } from "./storage/schedules.js";

export { logger, type LogLevel } from "./util/log.js";
