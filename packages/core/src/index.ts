/**
 * @duskfleet/core public surface. Everything the MCP server, the CLI and the
 * web dashboard need is exported from here.
 */

export {
  assertAgentIdFree,
  assertAgentWritable,
  assertSpecLoadable,
  createAgentFromFields,
  writeAgentAndVerify,
} from "./config/agent-create.js";
export {
  AGENT_ID_PATTERN,
  type AgentKind,
  type AgentSpec,
  agentDefinitionHash,
  agentFilePath,
  agentKind,
  agentSpecSchema,
  agentToSpec,
  assertAgentKind,
  assertWrapUpReserve,
  deleteAgentFile,
  envPassthroughSchema,
  listProjectAgents,
  type ProjectAgentInfo,
  projectAgentDefinitionHash,
  renderAgentMarkdown,
  writeAgentFile,
} from "./config/agent-files.js";
export { type AgentLintProblem, assertAgentSpecClean, collapseHome, lintAgentSpec } from "./config/agent-lint.js";
export {
  ConfigNotFoundError,
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
export {
  childEnv,
  DEFAULT_ENV_ALLOW,
  ENV_PASSTHROUGH_PATTERN,
  envNameMatches,
  mergeEnvPassthrough,
} from "./execution/child-env.js";
export {
  billingTypeOf,
  ClaudeCodeExecutor,
  type ClaudeCodeExecutorOptions,
  resolveClaudeBinary,
} from "./execution/claude-code.js";
export { mergeSubagent, needsRepair, sameSubagent, subagentsFromLog } from "./execution/log-replay.js";
export { allowListedMcpPrefixes, mcpToolPrefix, missingMcpServers } from "./execution/mcp.js";
export {
  DEFAULT_PATH_DIRS,
  effectivePath,
  isMinimalPath,
  pathDefaulted,
  withEffectivePath,
} from "./execution/search-path.js";
export {
  cleanHandBack,
  createStreamState,
  ingestLine,
  isRawHandBack,
  looksLikeContextExhaustion,
  type ParsedResult,
  type StreamState,
} from "./execution/stream-json.js";
export * from "./execution/types.js";
export {
  captureRunDiff,
  DIFF_MAX_COUNTED_BYTES,
  DIFF_MAX_COUNTED_FILES,
  DIFF_MAX_FILES,
  DIFF_MAX_PATCH_BYTES,
  DIFF_TIME_BUDGET_MS,
  type DiffFile,
  type DiffFileStatus,
  gitEnv,
  headSha,
  parseNameStatus,
  parseNumstat,
  type RunDiff,
} from "./git/diff.js";
export * from "./observability/failure.js";
export * from "./observability/run.js";
export {
  BUDGET_SCOPES,
  type Budget,
  BudgetError,
  type BudgetInput,
  type BudgetScope,
  type BudgetSource,
  type BudgetState,
  type BudgetStatus,
  budgetLabel,
  budgetStatus,
  budgetStatuses,
  budgetStatusOf,
  DEFAULT_WARN_PERCENT,
  utcMonthStart,
  validateBudgetInput,
} from "./orchestration/budget.js";
export { BusyError } from "./orchestration/busy.js";
export { DailyCapError, utcDayStart } from "./orchestration/daily-cap.js";
export { ProjectValidationError, validateProjectPath } from "./orchestration/project-validation.js";
export {
  budgetPlan,
  mergeResults,
  type ResumeRunInput,
  RunManager,
  type RunManagerOptions,
  resumePrompt,
  type StartRunInput,
  WRAP_UP_PROMPT,
} from "./orchestration/run-manager.js";
export { assertTransition, IllegalTransitionError } from "./orchestration/run-state.js";
export { allowListedMcpMissing, summarizeToolInput } from "./orchestration/tool-summary.js";
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
  assertCommandGateAllowed,
  autoPauseReason,
  COMMAND_GATES_OFF,
  commandGateRefusal,
  createSchedule,
  DEFAULT_TIME_ZONE,
  effectiveOnFailure,
  formatHolder,
  nextRunAtFor,
  parseHolder,
  processIdentity,
  type ScheduleRunState,
  type SchedulerRole,
  scheduleProjectId,
  scheduleRunState,
  updateSchedule,
  validateScheduleInput,
  willResume,
} from "./scheduler/crud.js";
export {
  evaluateGate,
  type GateVerdict,
  gateSaysNoWork,
  runCommandGate,
  validateGate,
} from "./scheduler/gate.js";
export {
  computeIdleStats,
  DEFAULT_NOOP_PATTERN,
  type IdleStats,
  isNoopRun,
  NOOP_TEXT_LIMIT,
  parseNoopPattern,
  scheduleIdleStats,
} from "./scheduler/idle.js";
export { attachLastRun, type RunSummarySource, type ScheduleWithLastRun } from "./scheduler/last-run.js";
export { type FireResult, Scheduler, type SchedulerOptions, type SchedulerStatus } from "./scheduler/scheduler.js";
export * from "./scheduler/types.js";
export { BudgetRepository } from "./storage/budgets.js";
export { migrationDigests, openDatabase } from "./storage/db.js";
export {
  type ListRunsFilter,
  NEEDS_REVIEW_SQL,
  RUN_OUTCOMES,
  type RunOutcome,
  type RunPatch,
  RunRepository,
} from "./storage/runs.js";
export { type EndedRunFacts, parseGate, ScheduleRepository } from "./storage/schedules.js";

export { type LogLevel, logger } from "./util/log.js";
