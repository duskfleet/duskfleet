/**
 * A second harness for the tests of the harness seam (issue #445): an in-process executor with a
 * reduced capability set and no dollar costs, standing in for a Codex / Copilot adapter. It spawns
 * nothing: `execute` records the request, writes one log line and ends the run `completed` with
 * one tool call and `costUsd: null`. `calls` / `prepared` are what the tests read.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** What the fake declares: no allow-list, no hard budget, no dollars, no resume, no Claude-only fields. */
export const FAKE_CAPABILITIES = Object.freeze({
  toolAllowList: false,
  permissionModes: ["acceptEdits"],
  resumeSession: false,
  hardBudgetUsd: false,
  reportsCostUsd: false,
  subagents: false,
  mcpInherit: false,
  projectAgents: false,
  addDirs: false,
  skills: false,
  effort: false,
  sandbox: false,
});

export class FakeHarness {
  name = "fake-harness";
  binary = "/opt/fake-harness/bin/fake";
  /** Requests `execute` received, in order. */
  calls = [];
  /** Requests `prepare` received, in order. */
  prepared = [];

  constructor({ versionError = null, harness = "fake", capabilities = FAKE_CAPABILITIES } = {}) {
    this.versionError = versionError;
    this.harness = harness;
    this.capabilities = capabilities;
  }

  version() {
    return this.versionError ? Promise.reject(new Error(this.versionError)) : Promise.resolve("fake 1.0.0");
  }

  prepare(request) {
    this.prepared.push(request);
    return { notes: ["fake harness: prepared"] };
  }

  execute(request, onEvent) {
    this.calls.push(request);
    const startedAt = new Date().toISOString();
    if (request.logPath) {
      mkdirSync(path.dirname(request.logPath), { recursive: true });
      appendFileSync(request.logPath, `${JSON.stringify({ type: "fake", prompt: request.prompt })}\n`);
    }
    const done = new Promise((resolve) => {
      setTimeout(() => {
        onEvent?.({
          type: "init",
          sessionId: request.sessionId,
          model: "fake-model",
          tools: ["shell"],
          mcpServers: [],
          cliVersion: "fake 1.0.0",
        });
        onEvent?.({ type: "tool_use", name: "shell", id: "t1", input: { command: "ls" }, agentId: null });
        onEvent?.({ type: "assistant_text", text: "done", agentId: null });
        const endedAt = new Date().toISOString();
        resolve({
          outcome: "completed",
          sessionId: request.sessionId,
          model: "fake-model",
          startedAt,
          endedAt,
          durationMs: 5,
          exitCode: 0,
          signal: null,
          terminationReason: "completed",
          error: null,
          resultText: "done",
          numTurns: 1,
          toolCalls: 1,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          usageByModel: null,
          costUsd: null,
          permissionDenials: 0,
          deniedTools: [],
          contextExhausted: false,
          failure: null,
          rawResult: null,
          subagents: [],
        });
      }, 10);
    });
    return {
      command: { binary: this.binary, argv: ["exec", "--json"], cwd: request.cwd },
      pid: null,
      done,
      cancel() {},
    };
  }
}
