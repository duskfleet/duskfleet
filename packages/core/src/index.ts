/**
 * @duskfleet/core public surface. Everything the MCP server, the CLI and the
 * web dashboard need is exported from here.
 */

export {
  AGENT_ID_PATTERN,
  type AgentKind,
  type AgentSpec,
  agentFilePath,
  agentKind,
  agentSpecSchema,
  agentToSpec,
  assertAgentKind,
  assertWrapUpReserve,
  deleteAgentFile,
  listProjectAgents,
  type ProjectAgentInfo,
  projectAgentDefinitionHash,
  renderAgentMarkdown,
  writeAgentFile,
} from "./config/agent-files.js";
export {
  expandHome,
  findRepoRoot,
  isDirectory,
  loadAgents,
  loadConfig,
  resolveConfigDir,
  splitFrontmatter,
} from "./config/loader.js";
export {
  PROJECT_ID_PATTERN,
  projectIdFromPath,
  readUserProjects,
  type UserProjectEntry,
  upsertUserProject,
} from "./config/project-files.js";
export * from "./config/types.js";
export * from "./evals/types.js";
export { ClaudeCodeExecutor, type ClaudeCodeExecutorOptions, resolveClaudeBinary } from "./execution/claude-code.js";
export { mergeSubagent, needsRepair, subagentsFromLog } from "./execution/log-replay.js";
export {
  cleanHandBack,
  createStreamState,
  ingestLine,
  looksLikeContextExhaustion,
  type ParsedResult,
  type StreamState,
} from "./execution/stream-json.js";
export * from "./execution/types.js";
export * from "./observability/run.js";
export { ProjectValidationError, validateProjectPath } from "./orchestration/project-validation.js";

export {
  budgetPlan,
  mcpToolPrefix,
  mergeResults,
  type ResumeRunInput,
  RunManager,
  type RunManagerOptions,
  resumePrompt,
  type StartRunInput,
  WRAP_UP_PROMPT,
} from "./orchestration/run-manager.js";
export { assertTransition, IllegalTransitionError } from "./orchestration/run-state.js";
export { summarizeToolInput } from "./orchestration/tool-summary.js";
export {
  assertTimeZone,
  CronError,
  type CronSpec,
  describeCron,
  localParts,
  nextFire,
  parseCron,
} from "./scheduler/cron.js";
export {
  createSchedule,
  DEFAULT_TIME_ZONE,
  effectiveOnFailure,
  formatHolder,
  nextRunAtFor,
  parseHolder,
  processIdentity,
  type ScheduleRunState,
  type SchedulerRole,
  scheduleRunState,
  updateSchedule,
  validateScheduleInput,
  willResume,
} from "./scheduler/crud.js";
export { attachLastRun, type RunSummarySource, type ScheduleWithLastRun } from "./scheduler/last-run.js";
export { Scheduler, type SchedulerOptions, type SchedulerStatus } from "./scheduler/scheduler.js";
export * from "./scheduler/types.js";
export { migrationDigests, openDatabase } from "./storage/db.js";
export { type ListRunsFilter, NEEDS_REVIEW_SQL, type RunPatch, RunRepository } from "./storage/runs.js";
export { ScheduleRepository } from "./storage/schedules.js";

export { type LogLevel, logger } from "./util/log.js";
