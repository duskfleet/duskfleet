/**
 * Schedule gates: a cheap check before a scheduled run, so a schedule that finds no work
 * skips for (almost) nothing instead of paying a full agent session to say "nothing to do".
 *
 *  - command gate: `sh -c <command>` in the project directory. Exit 0 = there is work, run.
 *    Non-zero = skip, its stdout (else stderr) is the reason. Timeout or spawn failure = error.
 *  - agent gate: a run of kind "gate" (own agent, prompt, small budget, no wrap-up). When its
 *    final message contains the marker (default NO_WORK) the real run is skipped. A gate run
 *    that fails is an error: the real run does not start on a broken gate.
 *
 * Generic on purpose: what "work" means (a ticket query, a git diff, a file) is the user's.
 */
import { spawn } from "node:child_process";
import type { DuskFleetConfig } from "../config/types.js";
import type { RunManager } from "../orchestration/run-manager.js";
import { validateProjectPath } from "../orchestration/project-validation.js";
import { DEFAULT_GATE_BUDGET_USD, DEFAULT_GATE_MARKER, DEFAULT_GATE_TIMEOUT_SECONDS, type Schedule, type ScheduleGate } from "./types.js";

export type GateVerdict =
  | { kind: "run"; gateRunId: string | null; costUsd: number; reason: string | null }
  | { kind: "skip"; gateRunId: string | null; costUsd: number; reason: string }
  | { kind: "error"; gateRunId: string | null; costUsd: number; reason: string };

const REASON_LIMIT = 2_000;

function clip(text: string): string {
  const t = text.trim();
  return t.length > REASON_LIMIT ? t.slice(0, REASON_LIMIT - 3) + "..." : t;
}

/** Validate a gate before it is stored (shared by MCP, CLI and dashboard through crud.ts). */
export function validateGate(config: DuskFleetConfig, gate: ScheduleGate, scheduleProjectId: string | null): void {
  const hasCommand = typeof gate.command === "string";
  const hasAgent = gate.agent !== undefined && gate.agent !== null;
  if (hasCommand === hasAgent) throw new Error("gate needs exactly one of command or agent");
  if (hasCommand) {
    if (!gate.command!.trim()) throw new Error("gate.command is empty");
    if (gate.timeoutSeconds !== undefined && !(gate.timeoutSeconds > 0 && gate.timeoutSeconds <= 600)) {
      throw new Error("gate.timeout_seconds must be between 1 and 600");
    }
    return;
  }
  const a = gate.agent!;
  const agent = config.agents.get(a.agentId);
  if (!agent) throw new Error(`gate agent "${a.agentId}" is unknown. Known: ${[...config.agents.keys()].join(", ")}`);
  if (!a.prompt?.trim()) throw new Error("gate.agent.prompt is required");
  if (a.budgetUsd !== undefined && !(a.budgetUsd > 0)) throw new Error("gate.agent.budget_usd must be positive");
  if (a.marker !== undefined && !a.marker.trim()) throw new Error("gate.agent.marker is empty");
  if (agent.project && scheduleProjectId && agent.project !== scheduleProjectId) {
    throw new Error(`gate agent "${a.agentId}" belongs to project "${agent.project}"; the schedule runs on "${scheduleProjectId}"`);
  }
}

/** Resolve the directory a command gate runs in: the schedule's project, else its agent's. */
function projectPathFor(config: DuskFleetConfig, s: Schedule): string {
  const projectId = s.projectId ?? config.agents.get(s.agentId)?.project ?? null;
  const project = projectId ? config.projects.get(projectId) : undefined;
  if (!project) throw new Error(`schedule "${s.name}" has no resolvable project for its gate`);
  return validateProjectPath(project.path, config);
}

export function runCommandGate(command: string, cwd: string, timeoutSeconds = DEFAULT_GATE_TIMEOUT_SECONDS): Promise<GateVerdict> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      // A gate is a user-written shell command by definition (pipes, &&, jq...): run it through sh.
      child = spawn("/bin/sh", ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ kind: "error", gateRunId: null, costUsd: 0, reason: `gate command could not start: ${String(err)}` });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    child.stdout!.setEncoding("utf8").on("data", (c: string) => (stdout = (stdout + c).slice(-8_000)));
    child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-8_000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ kind: "error", gateRunId: null, costUsd: 0, reason: `gate command failed to run: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ kind: "error", gateRunId: null, costUsd: 0, reason: `gate command timed out after ${timeoutSeconds}s` });
      const out = clip(stdout) || clip(stderr);
      if (code === 0) return resolve({ kind: "run", gateRunId: null, costUsd: 0, reason: out || null });
      resolve({ kind: "skip", gateRunId: null, costUsd: 0, reason: out || `gate command exited ${code}` });
    });
  });
}

export async function runAgentGate(runs: RunManager, s: Schedule, gate: NonNullable<ScheduleGate["agent"]>): Promise<GateVerdict> {
  const marker = gate.marker ?? DEFAULT_GATE_MARKER;
  const input: Parameters<RunManager["startRun"]>[0] = {
    prompt: gate.prompt,
    agentId: gate.agentId,
    scheduleId: s.id,
    kind: "gate",
    maxBudgetUsd: gate.budgetUsd ?? DEFAULT_GATE_BUDGET_USD,
  };
  const projectId = s.projectId ?? runs.config.agents.get(s.agentId)?.project ?? null;
  if (projectId) input.projectId = projectId;
  if (gate.model) input.model = gate.model;
  const started = await runs.startRun(input); // busy → throws, the caller records skipped_busy
  const agent = runs.config.agents.get(gate.agentId);
  const timeoutMs = (agent?.timeoutMinutes ?? runs.config.claude.defaultTimeoutMinutes) * 60_000 + 30_000;
  const run = await runs.waitForRun(started.id, timeoutMs);
  const costUsd = run.costUsd ?? 0;
  if (run.status !== "completed") {
    return { kind: "error", gateRunId: run.id, costUsd, reason: `gate run ${run.id} ended ${run.status}${run.error ? `: ${clip(run.error)}` : ""}` };
  }
  const text = run.resultText ?? "";
  if (text.includes(marker)) return { kind: "skip", gateRunId: run.id, costUsd, reason: clip(text) };
  return { kind: "run", gateRunId: run.id, costUsd, reason: text ? clip(text) : null };
}

/** Evaluate a schedule's gate. Never throws for a gate problem: that is an `error` verdict. Busy errors from startRun propagate. */
export async function evaluateGate(runs: RunManager, s: Schedule): Promise<GateVerdict> {
  const gate = s.gate!;
  if (gate.command !== undefined) {
    let cwd: string;
    try {
      cwd = projectPathFor(runs.config, s);
    } catch (err) {
      return { kind: "error", gateRunId: null, costUsd: 0, reason: err instanceof Error ? err.message : String(err) };
    }
    return runCommandGate(gate.command, cwd, gate.timeoutSeconds ?? DEFAULT_GATE_TIMEOUT_SECONDS);
  }
  return runAgentGate(runs, s, gate.agent!);
}
