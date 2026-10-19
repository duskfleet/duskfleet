/**
 * Replays a run's raw log (`data/logs/<run_id>.jsonl`) through the stream parser.
 * Used by the one-shot subagent backfill (`RunManager.repairSubagents`, CLI
 * `repair-subagents`): the log keeps every line Claude Code printed, so whatever the parser
 * learns later can be applied to past runs. Never called on a read path.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { cleanHandBack, createStreamState, ingestLine, isRawHandBack } from "./stream-json.js";
import type { SubagentRecord } from "./types.js";

/**
 * Subagent records as the current parser reads them from the log, or null when there is no log
 * to read (missing file, or no stream-json line in it). Streams the file line by line.
 *
 * A replay runs long after the run, so anything the parser took from the wall clock is the
 * replay's time: a duration is kept only when it was measured (harness total or two stream
 * timestamps), and an end time only when the closing line carried a timestamp.
 */
export async function subagentsFromLog(logPath: string | null): Promise<SubagentRecord[] | null> {
  if (!logPath || !existsSync(logPath)) return null;
  const state = createStreamState();
  const lines = createInterface({
    input: createReadStream(logPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let read = 0;
  for await (const line of lines) {
    if (line.startsWith("#") || !line.trim()) continue; // #stderr / #resume markers, not stream-json
    ingestLine(state, line);
    read += 1;
  }
  if (read === 0) return null;
  return [...state.subagents.values()].map((s) => ({
    ...s,
    durationMs: state.measured.has(s.agentId) ? s.durationMs : null,
    endedAt: state.wallClockEnd.has(s.agentId) ? null : s.endedAt,
  }));
}

/**
 * Cheap pre-filter: a stored row of a finished run lacks something the log may supply (type,
 * brief, report, duration), still holds the raw hand-back frame, or was never closed (the
 * process died mid-run). Whether the log actually fixes it is decided by comparing the merge
 * with the stored row, so a row the log cannot complete is read but never rewritten.
 */
export function needsRepair(
  s: Pick<SubagentRecord, "subagentType" | "prompt" | "resultText" | "durationMs" | "endedAt" | "status">,
): boolean {
  return (
    s.status === "running" ||
    s.subagentType === "unknown" ||
    s.prompt === null ||
    s.resultText === null ||
    (s.endedAt !== null && s.durationMs === null) ||
    (s.resultText !== null && isRawHandBack(s.resultText))
  );
}

/**
 * The stored row completed with what the log says. Stored values win except where they are
 * missing or raw; the log wins for the harness's exact totals (duration when measured, tokens,
 * tool calls) and, when the log closed a row still open, for its status and end time. A failed
 * outcome in the log wins over a stored completed; nothing downgrades a stored failed/interrupted.
 */
export function mergeSubagent(stored: SubagentRecord, fromLog: SubagentRecord | undefined): SubagentRecord {
  const merged: SubagentRecord = { ...stored, usage: { ...stored.usage }, tools: [...stored.tools] };
  // A stored report that still holds the hand-back frame came from an older parser: the log's reading wins.
  const rawStored = merged.resultText !== null && isRawHandBack(merged.resultText);
  if (rawStored) merged.resultText = cleanHandBack(merged.resultText as string);
  if (!fromLog) return merged;
  if (merged.subagentType === "unknown") merged.subagentType = fromLog.subagentType;
  merged.description ??= fromLog.description;
  merged.prompt ??= fromLog.prompt;
  merged.resultText = (rawStored ? fromLog.resultText : null) ?? merged.resultText ?? fromLog.resultText;
  merged.model ??= fromLog.model;
  merged.parentToolUseId ??= fromLog.parentToolUseId;
  if (fromLog.status !== "running") {
    // The log closed the subagent. An open row takes its outcome and end time; a completed row
    // becomes failed when the log says failed; a stored failed or interrupted is never downgraded.
    if (merged.status === "running") {
      merged.status = fromLog.status;
      merged.endedAt = fromLog.endedAt ?? merged.endedAt;
    } else if (merged.status === "completed" && fromLog.status === "failed") {
      merged.status = "failed";
    }
  }
  // subagentsFromLog keeps a duration only when it was measured, never one from the replay's clock.
  merged.durationMs = fromLog.durationMs ?? merged.durationMs;
  merged.totalTokens = fromLog.totalTokens ?? merged.totalTokens;
  merged.toolCalls = Math.max(merged.toolCalls, fromLog.toolCalls);
  for (const t of fromLog.tools) if (!merged.tools.includes(t)) merged.tools.push(t);
  return merged;
}

/** Same row after a merge: nothing to write back. */
export function sameSubagent(a: SubagentRecord, b: SubagentRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
