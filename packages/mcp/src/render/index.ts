/** Human-readable CLI output (the default; `--json` prints the same value as JSON). */
export {
  AGENT_CREATE,
  type AgentCreated,
  type AgentView,
  agentKind,
  renderAgentCreated,
  renderAgents,
} from "./agents.js";
export { renderBudgetSet, renderBudgets } from "./budgets.js";
export { type DoctorReport, renderDoctor, WARN_MARK, warnLine } from "./doctor.js";
export { renderMcpStatus } from "./mcp-status.js";
export * from "./primitives.js";
export { type ProjectList, renderProjects } from "./projects.js";
export { causeText, costCell, renderRunResult, runReportLines, trimmedRun } from "./run.js";
export { type RunInfo, renderRunInfo } from "./run-info.js";
export { type RunListItem, renderRuns, SHORT_ID } from "./runs.js";
export {
  renderScheduleRequested,
  renderSchedules,
  type ScheduleList,
  scheduleRequestedLine,
  type Ticker,
} from "./schedules.js";
export {
  renderServiceInstalled,
  renderServiceUninstalled,
  type ServiceInstalled,
  type ServiceUninstalled,
} from "./service.js";
export {
  GLYPH,
  paint,
  ROLE_FORMAT,
  ROLES,
  type Role,
  runStatusSegments,
  STATUS_GLYPH,
  STATUS_ROLE,
  type StateRole,
  stateSegments,
} from "./theme.js";
