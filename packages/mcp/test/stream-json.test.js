/**
 * Parser unit tests: subagent lines are folded into SubagentRecords without touching
 * the main session's model or last text. Shapes mirror a real run of 2026-10-12.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createStreamState, ingestLine } from "@duskfleet/core";

const feed = (state, objects) => objects.flatMap((o) => ingestLine(state, JSON.stringify(o)));

const nested = (agentId, parent, type) => ({
  parent_tool_use_id: parent,
  agent_id: agentId,
  session_id: "s",
  subagent_type: type,
});

test("subagent lifecycle: task_started → nested messages → hand-back", () => {
  const state = createStreamState();
  const events = feed(state, [
    { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5", tools: [] },
    {
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-opus-5",
        content: [
          { type: "tool_use", id: "t_agent", name: "Agent", input: { subagent_type: "reviewer", prompt: "brief" } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "A",
      tool_use_id: "t_agent",
      description: "Review",
      subagent_type: "reviewer",
      prompt: "brief",
    },
    {
      type: "user",
      message: { content: [{ type: "text", text: "brief" }] },
      ...nested("A", "t_agent", "reviewer"),
      timestamp: "2026-10-12T20:00:00.000Z",
    },
    {
      type: "assistant",
      message: {
        id: "m2",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: "sub text" }],
        usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100 },
      },
      ...nested("A", "t_agent", "reviewer"),
    },
    {
      type: "assistant",
      message: {
        id: "m2",
        model: "claude-haiku-5-5",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100 },
      },
      ...nested("A", "t_agent", "reviewer"),
    },
    {
      type: "assistant",
      message: {
        id: "m3",
        model: "claude-haiku-5-5",
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      ...nested("A", "t_agent", "reviewer"),
    },
    {
      type: "system",
      subtype: "task_progress",
      task_id: "A",
      tool_use_id: "t_agent",
      usage: { total_tokens: 500, tool_uses: 1, duration_ms: 1000 },
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "A",
      tool_use_id: "t_agent",
      status: "completed",
      summary: "short",
      usage: { total_tokens: 900, duration_ms: 4000 },
    },
    {
      type: "user",
      message: {
        content: [{ tool_use_id: "t_agent", type: "tool_result", content: [{ type: "text", text: "full report" }] }],
      },
      parent_tool_use_id: null,
      timestamp: "2026-10-12T20:00:05.000Z",
    },
    {
      type: "assistant",
      message: { id: "m4", model: "claude-opus-5", content: [{ type: "text", text: "main text" }], usage: {} },
      parent_tool_use_id: null,
    },
  ]);

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "init",
    "tool_use",
    "subagent_start",
    "assistant_text",
    "tool_use",
    "tool_use",
    "subagent_end",
    "assistant_text",
  ]);
  assert.equal(events[1].agentId, null, "the Agent call belongs to the main session");
  assert.equal(events[4].agentId, "A");
  assert.equal(events[7].agentId, null);

  assert.equal(state.model, "claude-opus-5", "subagent model must not leak into the run model");
  assert.equal(state.lastAssistantText, "main text");
  assert.equal(state.toolCalls, 3, "run total counts subagent tool calls");

  const [sub] = [...state.subagents.values()];
  assert.equal(sub.agentId, "A");
  assert.equal(sub.parentToolUseId, "t_agent");
  assert.equal(sub.parentAgentId, null);
  assert.equal(sub.subagentType, "reviewer");
  assert.equal(sub.description, "Review");
  assert.equal(sub.prompt, "brief");
  assert.equal(sub.model, "claude-haiku-5-5");
  assert.equal(sub.status, "completed");
  assert.equal(sub.resultText, "full report", "the hand-back wins over the notification summary");
  assert.equal(sub.durationMs, 4000, "duration from task_notification");
  assert.equal(sub.totalTokens, 900, "the notification's total wins over the last progress line");
  assert.equal(sub.startedAt, "2026-10-12T20:00:00.000Z", "stream timestamp, not wall-clock");
  assert.equal(sub.endedAt, "2026-10-12T20:00:05.000Z");
  assert.equal(sub.toolCalls, 2);
  assert.deepEqual(sub.tools, ["Bash"]);
  assert.deepEqual(
    sub.usage,
    { inputTokens: 6, outputTokens: 12, cacheReadTokens: 100, cacheCreationTokens: null },
    "one API message counted once",
  );
});

test("nested subagents resolve their parent and a missing task_started is tolerated", () => {
  const state = createStreamState();
  feed(state, [
    {
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "t_a", name: "Agent", input: {} }],
      },
      parent_tool_use_id: null,
    },
    // No task_started line: the first nested message registers the subagent.
    {
      type: "user",
      message: { content: [{ type: "text", text: "brief A" }] },
      ...nested("A", "t_a", "coordinator"),
      task_description: "Coordinate",
    },
    {
      type: "assistant",
      message: {
        id: "m2",
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "t_b", name: "Agent", input: {} }],
      },
      ...nested("A", "t_a", "coordinator"),
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "B",
      tool_use_id: "t_b",
      description: "Design",
      subagent_type: "designer",
      prompt: "brief B",
    },
    {
      type: "assistant",
      message: {
        id: "m3",
        model: "claude-sonnet-5",
        content: [{ type: "tool_use", id: "t_x", name: "mcp__claude_ai_Figma__use_figma", input: {} }],
      },
      ...nested("B", "t_b", "designer"),
    },
    {
      type: "user",
      message: { content: [{ tool_use_id: "t_b", type: "tool_result", content: "B done" }] },
      ...nested("A", "t_a", "coordinator"),
    },
    {
      type: "user",
      message: { content: [{ tool_use_id: "t_a", type: "tool_result", content: "A done" }] },
      parent_tool_use_id: null,
    },
  ]);
  const a = state.subagents.get("A");
  const b = state.subagents.get("B");
  assert.equal(a.description, "Coordinate");
  assert.equal(a.prompt, "brief A");
  assert.equal(a.parentAgentId, null);
  assert.equal(b.parentAgentId, "A", "B was spawned by A's Agent call");
  assert.equal(b.parentToolUseId, "t_b");
  assert.deepEqual(b.tools, ["mcp__claude_ai_Figma__use_figma"]);
  assert.equal(b.status, "completed");
  assert.equal(b.resultText, "B done");
  assert.equal(a.status, "completed");
  assert.equal(a.resultText, "A done");
  assert.equal(a.toolCalls, 1, "A's own Agent call counts for A");
});

test("a failed notification keeps the failed status after the hand-back", () => {
  const state = createStreamState();
  feed(state, [
    { type: "system", subtype: "task_started", task_id: "A", tool_use_id: "t_a", subagent_type: "x" },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "A",
      tool_use_id: "t_a",
      status: "failed",
      summary: "boom",
    },
    {
      type: "user",
      message: { content: [{ tool_use_id: "t_a", type: "tool_result", content: "error text" }] },
      parent_tool_use_id: null,
    },
  ]);
  const a = state.subagents.get("A");
  assert.equal(a.status, "failed");
  assert.equal(a.resultText, "error text");
});
