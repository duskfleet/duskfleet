/**
 * `doctor --probe`: one minimal real run, to catch what `claude --version` cannot (expired
 * auth, a user-level hook that blocks or outlives a headless child) before a scheduled run
 * trips over it. It costs real money (cents, on haiku), so it is opt-in.
 *
 * The probe goes through the executor directly, not RunManager: it is a diagnostic, not a run,
 * so it records no row and needs no project. It gets the same unattended envelope as every run
 * (setting sources, strict MCP, no permission prompts) in an empty temporary directory, with no
 * tools allowed (`dontAsk` and an empty allow-list), a small budget cap and a short timeout.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeConfig, Executor } from "@duskfleet/core";

export const PROBE_MODEL = "haiku";
export const PROBE_PROMPT = "Reply with the single word: pong";
/** Spending cap passed as --max-budget-usd; a hello on haiku costs well under a cent. */
export const PROBE_MAX_BUDGET_USD = 0.05;
/** Upper bound of the probe's timeout; a lower claude.default_timeout_minutes wins. */
export const PROBE_MAX_TIMEOUT_MS = 2 * 60 * 1000;
export const PROBE_COST_NOTE = `doctor --probe makes one real Claude run on ${PROBE_MODEL} (costs a few cents at most, capped at $${PROBE_MAX_BUDGET_USD})`;

export interface ProbeReport {
  ok: boolean;
  outcome: string;
  model: string | null;
  durationMs: number;
  costUsd: number | null;
  resultText: string | null;
  error: string | null;
  /** The process (or a descendant such as a Stop hook) kept running after its result line. */
  lingeredAfterResult: boolean;
  advice: string | null;
  note: string;
}

const AUTH_PATTERN =
  /\b(log ?in|logged out|auth\w*|api key|credential|unauthori[sz]ed|401|403|oauth|token (expired|revoked))\b/i;

export async function runProbe(
  executor: Executor,
  claude: Pick<ClaudeConfig, "defaultTimeoutMinutes">,
): Promise<ProbeReport> {
  const cwd = mkdtempSync(path.join(tmpdir(), "duskfleet-probe-"));
  const timeoutMs = Math.min(PROBE_MAX_TIMEOUT_MS, claude.defaultTimeoutMinutes * 60 * 1000);
  let lingered = false;
  // The child is spawned detached and paid: on Ctrl-C (or a kill) cancel it, wait for it to
  // end and remove the temp dir before exiting, or it would run on up to the budget cap.
  let onSignal: (() => void) | null = null;
  let interrupted = false;
  try {
    const handle = executor.execute(
      {
        cwd,
        prompt: PROBE_PROMPT,
        sessionId: randomUUID(),
        permissionMode: "dontAsk",
        model: PROBE_MODEL,
        maxBudgetUsd: PROBE_MAX_BUDGET_USD,
        timeoutMs,
      },
      (event) => {
        if (event.type === "grace_kill") lingered = true;
      },
    );
    // Installing a listener replaces Node's default exit on these signals, so the await below
    // still returns once the cancelled child is gone; the finally cleans up and the caller
    // exits 130 (after closing the app). `on`, not `once`, with an idempotent handler: a second
    // Ctrl-C must not find Node's default handler, which would kill doctor before the cleanup.
    onSignal = (): void => {
      if (interrupted) return;
      interrupted = true;
      process.stderr.write("doctor --probe interrupted: cancelling the probe run\n");
      handle.cancel();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const r = await handle.done;
    if (interrupted) {
      return {
        ...probeNotRun("interrupted", "interrupted by a signal; the probe run was cancelled", null),
        model: r.model,
        durationMs: r.durationMs,
        costUsd: r.costUsd,
      };
    }
    const ok = r.outcome === "completed" && !lingered;
    return {
      ok,
      outcome: r.outcome,
      model: r.model,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
      resultText: r.resultText,
      error: r.error,
      lingeredAfterResult: lingered,
      advice: probeAdvice(r.outcome, r.error, lingered, timeoutMs),
      note: PROBE_COST_NOTE,
    };
  } finally {
    if (onSignal) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * A probe that never got a result from Claude: `skipped` (claude --version already failed, so
 * nothing was spent), `error` (the probe itself threw before or around the run) or
 * `interrupted` (SIGINT/SIGTERM cancelled it; doctor prints no report and exits 130).
 */
export function probeNotRun(
  outcome: "skipped" | "error" | "interrupted",
  error: string,
  advice: string | null,
): ProbeReport {
  return {
    ok: false,
    outcome,
    model: null,
    durationMs: 0,
    costUsd: null,
    resultText: null,
    error,
    lingeredAfterResult: false,
    advice,
    note: PROBE_COST_NOTE,
  };
}

export function probeAdvice(
  outcome: string,
  error: string | null,
  lingered: boolean,
  timeoutMs: number,
): string | null {
  if (outcome === "timed_out") {
    return `no result within ${Math.round(timeoutMs / 1000)} s: a hook or a prompt is likely blocking the headless child; check claude.setting_sources in duskfleet.yaml and the hooks of the setting sources it loads`;
  }
  if (outcome === "failed") {
    if (error && AUTH_PATTERN.test(error)) {
      return 'Claude Code is not authenticated: run "claude" interactively and log in (or check ANTHROPIC_API_KEY), then probe again';
    }
    return "the probe run failed (see probe.error); scheduled runs would likely fail the same way";
  }
  if (lingered) {
    return "the process kept running after its result (a Stop hook?); DuskFleet ends it after a grace period, but set claude.setting_sources: [project, local] in duskfleet.yaml to skip user-level hooks";
  }
  return null;
}
