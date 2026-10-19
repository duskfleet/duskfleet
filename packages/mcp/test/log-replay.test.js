/**
 * Log replay and merge rules of the subagent backfill: what the log may change in a stored row,
 * and what a replay must not take from its own clock.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mergeSubagent, subagentsFromLog } from "@duskfleet/core";

const row = (over = {}) => ({
  agentId: "A",
  parentToolUseId: "t",
  parentAgentId: null,
  subagentType: "x",
  description: "d",
  prompt: "p",
  resultText: "r",
  status: "completed",
  model: "m",
  startedAt: "2026-10-14T08:30:00.000Z",
  endedAt: "2026-10-14T08:31:00.000Z",
  durationMs: 60_000,
  toolCalls: 1,
  tools: ["Read"],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  totalTokens: 10,
  ...over,
});

test("a failed outcome in the log replaces a stored completed", () => {
  assert.equal(mergeSubagent(row(), row({ status: "failed" })).status, "failed");
});

test("a stored failed or interrupted status is never downgraded by the log", () => {
  assert.equal(mergeSubagent(row({ status: "failed" }), row({ status: "completed" })).status, "failed");
  const interrupted = row({ status: "interrupted", endedAt: "2026-10-14T09:00:00.000Z" });
  const merged = mergeSubagent(interrupted, row({ status: "completed" }));
  assert.equal(merged.status, "interrupted");
  assert.equal(merged.endedAt, "2026-10-14T09:00:00.000Z");
});

test("an open row takes status and end time from the log", () => {
  const merged = mergeSubagent(row({ status: "running", endedAt: null }), row({ status: "failed" }));
  assert.equal(merged.status, "failed");
  assert.equal(merged.endedAt, "2026-10-14T08:31:00.000Z");
});

test("a log without a measured duration keeps the stored one", () => {
  assert.equal(mergeSubagent(row(), row({ durationMs: null })).durationMs, 60_000);
  assert.equal(mergeSubagent(row({ durationMs: null }), row({ durationMs: null })).durationMs, null);
});

test("subagentsFromLog: null without a log, and no duration or end time from the replay's clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-replay-"));
  try {
    assert.equal(await subagentsFromLog(null), null);
    assert.equal(await subagentsFromLog(join(dir, "missing.jsonl")), null);
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "#stderr nothing\n\n");
    assert.equal(await subagentsFromLog(empty), null, "no stream-json line: nothing was read");

    const log = join(dir, "run.jsonl");
    const lines = [
      { type: "system", subtype: "task_started", task_id: "W", tool_use_id: "t_w" },
      { type: "user", message: { content: [{ tool_use_id: "t_w", type: "tool_result", content: "ok" }] } },
      { type: "system", subtype: "task_started", task_id: "T", tool_use_id: "t_t" },
      {
        type: "user",
        message: { content: [{ tool_use_id: "t_t", type: "tool_result", content: "ok" }] },
        timestamp: "2026-10-14T08:31:00.000Z",
        tool_use_result: { status: "completed", agentId: "T", totalDurationMs: 5000 },
      },
    ];
    writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const [w, t] = await subagentsFromLog(log);
    assert.equal(w.status, "completed");
    assert.equal(w.durationMs, null, "parse time minus parse time is not a duration");
    assert.equal(w.endedAt, null, "the replay's clock is not an end time");
    assert.equal(t.durationMs, 5000, "harness total kept");
    assert.equal(t.endedAt, "2026-10-14T08:31:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
