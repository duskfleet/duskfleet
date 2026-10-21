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
    const r = await handle.done;
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
    rmSync(cwd, { recursive: true, force: true });
  }
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
