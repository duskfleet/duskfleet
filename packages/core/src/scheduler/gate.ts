/**
 * Schedule gates: a cheap check before a scheduled run, so a schedule that finds no work
 * skips for (almost) nothing instead of paying a full agent session to say "nothing to do".
 *
 *  - command gate: `sh -c <command>` in the project directory. Exit 0 = there is work, run.
 *    Exit 1-125 = skip, its stdout (else stderr) is the reason. 126 / 127 (not executable,
 *    not found: a typo or a PATH without the tool), death by signal, timeout or spawn failure
 *    = error: a broken gate must not read as "idle".
 *  - agent gate: a run of kind "gate" (own agent, prompt, small budget, no wrap-up). When the
 *    last line of its final message is the marker (default NO_WORK) the real run is skipped. A
 *    gate run that fails or times out is an error: the real run does not start on a broken gate.
 *
 * Generic on purpose: what "work" means (a ticket query, a git diff, a file) is the user's.
 */
import { spawn } from "node:child_process";
import type { DuskFleetConfig } from "../config/types.js";
import { BusyError } from "../orchestration/busy.js";
import { DailyCapError } from "../orchestration/daily-cap.js";
import type { RunManager } from "../orchestration/run-manager.js";
import {
  DEFAULT_GATE_BUDGET_USD,
  DEFAULT_GATE_MARKER,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  type Schedule,
  type ScheduleGate,
} from "./types.js";

/**
 * What the gate decided. `busy` = the gate agent's run was refused by the WIP guards (the
 * tick is skipped as busy, nothing was spent). Every verdict carries what the gate cost.
 */
export type GateVerdict =
  | { kind: "run"; gateRunId: string | null; costUsd: number; reason: string | null }
  | { kind: "skip"; gateRunId: string | null; costUsd: number; reason: string }
  | { kind: "busy"; gateRunId: null; costUsd: 0; reason: string }
  | { kind: "daily_cap"; gateRunId: null; costUsd: 0; reason: string }
  | { kind: "error"; gateRunId: string | null; costUsd: number; reason: string };

const REASON_LIMIT = 2_000;
/** How long a cancelled gate run gets to record its final state (and cost). */
const CANCEL_GRACE_MS = 15_000;

function clip(text: string): string {
  const t = text.trim();
  return t.length > REASON_LIMIT ? `${t.slice(0, REASON_LIMIT - 3)}...` : t;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate a gate before it is stored (shared by MCP, CLI and dashboard through crud.ts). */
export function validateGate(config: DuskFleetConfig, gate: ScheduleGate, scheduleProjectId: string | null): void {
  if (gate.invalid !== undefined) throw new Error(gate.invalid);
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
    throw new Error(
      `gate agent "${a.agentId}" belongs to project "${agent.project}"; the schedule runs on "${scheduleProjectId}"`,
    );
  }
}

/**
 * Whether an agent gate's final message says "no work": its last non-empty line, without
 * markdown emphasis, quotes or a trailing full stop, is the marker (case-insensitive). A
 * marker mentioned mid-sentence ("... so this is not NO_WORK") does not count.
 */
export function gateSaysNoWork(text: string, marker: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return false;
  const token = last.replace(/^[\s*_`>"'#-]+/, "").replace(/[\s*_`"'.!]+$/, "");
  return token.toLowerCase() === marker.trim().toLowerCase();
}

/** Kill the gate's whole process group: `sh -c "a | b"` leaves grandchildren holding the pipes. */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // group already gone: fall through to the child itself
    }
  }
  fallback();
}

export function runCommandGate(
  command: string,
  cwd: string,
  timeoutSeconds = DEFAULT_GATE_TIMEOUT_SECONDS,
): Promise<GateVerdict> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (v: GateVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // A gate is a user-written shell command by definition (pipes, &&, jq...): run it through
      // sh, in its own process group so a timeout can kill everything it started.
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ kind: "error", gateRunId: null, costUsd: 0, reason: `gate command could not start: ${message(err)}` });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
      // A grandchild outside the group could still hold the pipes open: do not wait on `close`.
      done({ kind: "error", gateRunId: null, costUsd: 0, reason: `gate command timed out after ${timeoutSeconds}s` });
    }, timeoutSeconds * 1000);
    child.stdout!.setEncoding("utf8").on("data", (c: string) => {
      stdout = (stdout + c).slice(-8_000);
    });
    child.stderr!.setEncoding("utf8").on("data", (c: string) => {
      stderr = (stderr + c).slice(-8_000);
    });
    child.on("error", (err) => {
      done({ kind: "error", gateRunId: null, costUsd: 0, reason: `gate command failed to run: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      if (timedOut) return;
      const out = clip(stdout) || clip(stderr);
      if (code === 0) return done({ kind: "run", gateRunId: null, costUsd: 0, reason: out || null });
      if (code === null || code === 126 || code === 127 || code > 128) {
        const why =
          code === null || code > 128
            ? `killed by ${signal ?? `signal ${code! - 128}`}`
            : code === 127
              ? "exited 127 (command not found: check the command and the PATH of the scheduler process)"
              : "exited 126 (not executable)";
        return done({
          kind: "error",
          gateRunId: null,
          costUsd: 0,
          reason: `gate command ${why}${out ? `: ${out}` : ""}`,
        });
      }
      done({ kind: "skip", gateRunId: null, costUsd: 0, reason: out || `gate command exited ${code}` });
    });
  });
}

export async function runAgentGate(
  runs: RunManager,
  s: Schedule,
  gate: NonNullable<ScheduleGate["agent"]>,
): Promise<GateVerdict> {
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
  let startedId: string;
  try {
    startedId = (await runs.startRun(input)).id;
  } catch (err) {
    if (err instanceof BusyError) return { kind: "busy", gateRunId: null, costUsd: 0, reason: err.message };
    if (err instanceof DailyCapError) return { kind: "daily_cap", gateRunId: null, costUsd: 0, reason: err.message };
    return { kind: "error", gateRunId: null, costUsd: 0, reason: `gate run did not start: ${message(err)}` };
  }
  try {
    const agent = runs.config.agents.get(gate.agentId);
    const timeoutMs = (agent?.timeoutMinutes ?? runs.config.claude.defaultTimeoutMinutes) * 60_000 + 30_000;
    let run = await runs.waitForRun(startedId, timeoutMs);
    if (run.status === "running" || run.status === "pending") {
      // Still going past its own timeout: stop it, it would keep spending and hold the agent and project slots.
      runs.cancelRun(run.id);
      run = await runs.waitForRun(run.id, CANCEL_GRACE_MS);
      return {
        kind: "error",
        gateRunId: run.id,
        costUsd: run.costUsd ?? 0,
        reason: `gate run ${run.id} did not finish in time and was cancelled`,
      };
    }
    const costUsd = run.costUsd ?? 0;
    if (run.status !== "completed") {
      return {
        kind: "error",
        gateRunId: run.id,
        costUsd,
        reason: `gate run ${run.id} ended ${run.status}${run.error ? `: ${clip(run.error)}` : ""}`,
      };
    }
    const text = run.resultText ?? "";
    if (gateSaysNoWork(text, marker)) return { kind: "skip", gateRunId: run.id, costUsd, reason: clip(text) };
    return { kind: "run", gateRunId: run.id, costUsd, reason: text ? clip(text) : null };
  } catch (err) {
    // The gate run started, so its cost is recorded even when reading its outcome failed.
    const run = runs.getRun(startedId);
    return {
      kind: "error",
      gateRunId: startedId,
      costUsd: run?.costUsd ?? 0,
      reason: `gate run ${startedId}: ${message(err)}`,
    };
  }
}

/**
 * Evaluate a schedule's gate. Never throws: a gate problem is an `error` verdict, a refused gate
 * run a `busy` one, so the caller always learns what the gate cost.
 */
export async function evaluateGate(runs: RunManager, s: Schedule): Promise<GateVerdict> {
  const gate = s.gate!;
  if (gate.invalid !== undefined) {
    return { kind: "error", gateRunId: null, costUsd: 0, reason: `stored gate is unusable: ${gate.invalid}` };
  }
  try {
    if (gate.command !== undefined) {
      // The directory the real run would use, resolved by RunManager exactly as startRun does.
      const cwd = runs.projectPathFor({ agentId: s.agentId, projectId: s.projectId });
      return await runCommandGate(gate.command, cwd, gate.timeoutSeconds ?? DEFAULT_GATE_TIMEOUT_SECONDS);
    }
    if (!gate.agent)
      return { kind: "error", gateRunId: null, costUsd: 0, reason: "gate has neither command nor agent" };
    return await runAgentGate(runs, s, gate.agent);
  } catch (err) {
    return { kind: "error", gateRunId: null, costUsd: 0, reason: message(err) };
  }
}
