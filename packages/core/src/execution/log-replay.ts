/**
 * Replays a run's raw log (`data/logs/<run_id>.jsonl`) through the stream parser.
 * Used to repair subagent rows recorded by an older parser: the log keeps every line
 * Claude Code printed, so whatever the parser learns later can be applied to past runs.
 */
import { existsSync, readFileSync } from "node:fs";
import { cleanHandBack, createStreamState, ingestLine } from "./stream-json.js";
import type { SubagentRecord } from "./types.js";

/** Subagent records as the current parser reads them from the log; empty when the log is missing. */
export function subagentsFromLog(logPath: string | null): SubagentRecord[] {
  if (!logPath || !existsSync(logPath)) return [];
  const state = createStreamState();
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.startsWith("#")) continue; // #stderr / #resume markers, not stream-json
    ingestLine(state, line);
  }
  return [...state.subagents.values()];
}

/** A stored row lacks something the log can supply (type, brief, report, counts) or still holds the raw hand-back frame. */
export function needsRepair(s: Pick<SubagentRecord, "subagentType" | "prompt" | "resultText" | "durationMs" | "endedAt" | "status">): boolean {
  if (s.status === "running") return false;
  return (
    s.subagentType === "unknown" ||
    s.prompt === null ||
    s.resultText === null ||
    (s.endedAt !== null && s.durationMs === null) ||
    (s.resultText !== null && cleanHandBack(s.resultText) !== s.resultText)
  );
}

/**
 * The stored row completed with what the log says. Stored values win except where they are
 * missing or raw; the log wins for the harness's exact totals (duration, tokens, tool calls).
 */
export function mergeSubagent(stored: SubagentRecord, fromLog: SubagentRecord | undefined): SubagentRecord {
  const merged: SubagentRecord = { ...stored, usage: { ...stored.usage }, tools: [...stored.tools] };
  // A stored report that still holds the hand-back frame came from an older parser: the log's reading wins.
  const rawStored = merged.resultText !== null && cleanHandBack(merged.resultText) !== merged.resultText;
  if (merged.resultText !== null) merged.resultText = cleanHandBack(merged.resultText);
  if (!fromLog) return merged;
  if (merged.subagentType === "unknown") merged.subagentType = fromLog.subagentType;
  merged.description ??= fromLog.description;
  merged.prompt ??= fromLog.prompt;
  merged.resultText = (rawStored ? fromLog.resultText : null) ?? merged.resultText ?? fromLog.resultText;
  merged.model ??= fromLog.model;
  merged.parentToolUseId ??= fromLog.parentToolUseId;
  merged.durationMs = fromLog.durationMs ?? merged.durationMs;
  merged.totalTokens = fromLog.totalTokens ?? merged.totalTokens;
  merged.toolCalls = Math.max(merged.toolCalls, fromLog.toolCalls);
  for (const t of fromLog.tools) if (!merged.tools.includes(t)) merged.tools.push(t);
  return merged;
}
