/** Human-readable CLI output (the default; `--json` prints the same value as JSON). */
export * from "./primitives.js";
export { costCell, renderRunResult, runReportLines, trimmedRun } from "./run.js";
export { type RunInfo, renderRunInfo } from "./run-info.js";
export { type RunListItem, renderRuns } from "./runs.js";
export { paint, ROLE_FORMAT, ROLES, type Role, STATUS_ROLE } from "./theme.js";
