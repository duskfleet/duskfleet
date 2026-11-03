/**
 * Evaluation foundations. Nothing produces evals yet; the types, the score schema
 * (`score.ts`) and the table exist so that evaluators can be added without touching the Run model.
 *
 * Isolation: evaluators write only to `evals`, through `EvalRepository`, never to `runs` (a run's
 * status and review reasons belong to `RunManager`). An LLM evaluator is a second, read-only
 * Claude Code run with its own `maxBudgetUsd`, never the evaluated run's budget.
 *
 * Planned:
 *  - deterministic evaluators (tests_passed, build_passed, files_exist, ...)
 *    defined in config/evals/*.yaml and run after a run reaches a terminal state
 *  - LLM evaluators implemented as a second, read-only Claude Code run
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type EvalDetails, scoreEval } from "./score.js";

export type EvalKind = "deterministic" | "llm";
export type EvalStatus = "pass" | "fail" | "error" | "skipped";

export interface EvalResult {
  id: string;
  runId: string;
  name: string;
  kind: EvalKind;
  status: EvalStatus;
  /** In [0, 1]; null when a hard check failed, or for `error` / `skipped`. */
  score: number | null;
  /** `EvalDetails` for pass / fail, `{ message }` for error / skipped. */
  details: EvalDetails | { message: string } | null;
  createdAt: string;
}

/** What an evaluator returns: scored details, or why it could not score. */
export type EvalOutcome = { details: EvalDetails } | { status: "error" | "skipped"; message: string };

interface EvaluatorBase {
  name: string;
  evaluate(runId: string): Promise<EvalOutcome>;
}

export interface DeterministicEvaluator extends EvaluatorBase {
  kind: "deterministic";
}

export interface LlmEvaluator extends EvaluatorBase {
  kind: "llm";
  /** Budget of the eval run itself (`--max-budget-usd`), separate from the evaluated run's. */
  maxBudgetUsd: number;
}

/** Contract every future evaluator implements. */
export type Evaluator = DeterministicEvaluator | LlmEvaluator;

export class EvalRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** The only write path of evals. Scored details go through `scoreEval` (throws on a bad shape). */
  record(runId: string, name: string, kind: EvalKind, outcome: EvalOutcome): EvalResult {
    const base = { id: randomUUID(), runId, name, kind, createdAt: new Date().toISOString() };
    let result: EvalResult;
    if ("details" in outcome) {
      const { status, score } = scoreEval(outcome.details);
      result = { ...base, status, score, details: outcome.details };
    } else {
      result = { ...base, status: outcome.status, score: null, details: { message: outcome.message } };
    }
    this.db
      .prepare(
        "INSERT INTO evals (id, run_id, name, kind, status, score, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        result.id,
        result.runId,
        result.name,
        result.kind,
        result.status,
        result.score,
        result.details === null ? null : JSON.stringify(result.details),
        result.createdAt,
      );
    return result;
  }

  forRun(runId: string): EvalResult[] {
    const rows = this.db.prepare("SELECT * FROM evals WHERE run_id = ? ORDER BY created_at").all(runId) as Array<{
      id: string;
      run_id: string;
      name: string;
      kind: EvalKind;
      status: EvalStatus;
      score: number | null;
      details: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      score: r.score,
      details: r.details === null ? null : JSON.parse(r.details),
      createdAt: r.created_at,
    }));
  }
}

/**
 * Runs one evaluator against a run and records the outcome. An LLM evaluator without a positive
 * `maxBudgetUsd` is refused before it runs; an evaluator that throws, or returns details that do
 * not match the schema, is recorded as `error`. Nothing here touches `runs`.
 */
export async function runEvaluator(repo: EvalRepository, evaluator: Evaluator, runId: string): Promise<EvalResult> {
  if (evaluator.kind === "llm" && !(Number.isFinite(evaluator.maxBudgetUsd) && evaluator.maxBudgetUsd > 0)) {
    throw new Error(`LLM evaluator "${evaluator.name}" needs its own maxBudgetUsd > 0`);
  }
  let outcome: EvalOutcome;
  try {
    outcome = await evaluator.evaluate(runId);
    if ("details" in outcome) scoreEval(outcome.details);
  } catch (err) {
    outcome = { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  return repo.record(runId, evaluator.name, evaluator.kind, outcome);
}
