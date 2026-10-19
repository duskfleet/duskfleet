/**
 * Evaluation foundations. Nothing in the MVP produces evals yet; the types and
 * table exist so that evaluators can be added without touching the Run model.
 *
 * Planned:
 *  - deterministic evaluators (tests_passed, build_passed, files_exist, ...)
 *    defined in config/evals/*.yaml and run after a run reaches a terminal state
 *  - LLM evaluators implemented as a second, read-only Claude Code run
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type EvalKind = "deterministic" | "llm";
export type EvalStatus = "pass" | "fail" | "error" | "skipped";

export interface EvalResult {
  id: string;
  runId: string;
  name: string;
  kind: EvalKind;
  status: EvalStatus;
  score: number | null;
  details: unknown;
  createdAt: string;
}

/** Contract every future evaluator implements. */
export interface Evaluator {
  name: string;
  kind: EvalKind;
  evaluate(runId: string): Promise<Omit<EvalResult, "id" | "runId" | "name" | "kind" | "createdAt">>;
}

export class EvalRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(input: Omit<EvalResult, "id" | "createdAt">): EvalResult {
    const result: EvalResult = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
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
        result.details === undefined ? null : JSON.stringify(result.details),
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
