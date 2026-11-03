/**
 * The schema of `evals.details` and the one rule that turns it into a status and a score.
 *
 * Scoring order:
 *  1. Hard checks (`checks`): pass/fail gates. Any failed check makes the run invalid: the eval is
 *     `fail` with a null score and the rubric is not scored at all.
 *  2. Rubric dimensions (`dimensions`): each scored on its own scale, 0-1 or 0-2 (integers). The
 *     score is the mean of `score / scale` over the dimensions, in [0, 1]. Only checks and no
 *     dimension, all passed, scores 1.
 *  3. Pairwise comparisons come later, as a schema version of their own.
 *
 * Cost and latency (`cost`, `latency`) are what the evaluation itself spent (the LLM eval run's
 * cost, the evaluator's wall time). They are stored beside the score and never blended into it;
 * the evaluated run's own cost and duration stay in `runs`.
 */

export const EVAL_DETAILS_SCHEMA = 1;

/** A pass/fail gate, scored before anything else. */
export interface EvalHardCheck {
  name: string;
  passed: boolean;
  message?: string;
}

/** Highest value a rubric dimension can take: 0-1 or 0-2. */
export type EvalRubricScale = 1 | 2;

export interface EvalRubricDimension {
  name: string;
  scale: EvalRubricScale;
  /** Integer in [0, scale]. */
  score: number;
  rationale?: string;
}

export interface EvalCost {
  usd: number | null;
}

export interface EvalLatency {
  durationMs: number | null;
}

/** What an evaluator writes into `evals.details` (JSON) for a scored eval. */
export interface EvalDetails {
  schema: typeof EVAL_DETAILS_SCHEMA;
  checks: EvalHardCheck[];
  dimensions: EvalRubricDimension[];
  cost: EvalCost | null;
  latency: EvalLatency | null;
}

export interface EvalScore {
  status: "pass" | "fail";
  /** Null when a hard check failed (the run is invalid, the rubric is not scored). */
  score: number | null;
  valid: boolean;
}

export class EvalDetailsError extends Error {
  constructor(message: string) {
    super(`invalid eval details: ${message}`);
    this.name = "EvalDetailsError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function assertNames(items: Array<Record<string, unknown>>, field: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.name !== "string" || item.name.trim() === "") throw new EvalDetailsError(`${field}: empty name`);
    if (seen.has(item.name)) throw new EvalDetailsError(`${field}: duplicate name "${item.name}"`);
    seen.add(item.name);
  }
}

/** Throws EvalDetailsError unless `value` matches the schema above. */
export function assertEvalDetails(value: unknown): asserts value is EvalDetails {
  if (!isRecord(value)) throw new EvalDetailsError("not an object");
  if (value.schema !== EVAL_DETAILS_SCHEMA) throw new EvalDetailsError(`schema must be ${EVAL_DETAILS_SCHEMA}`);
  const { checks, dimensions, cost, latency } = value;
  if (!Array.isArray(checks) || !checks.every(isRecord))
    throw new EvalDetailsError("checks must be an array of objects");
  if (!Array.isArray(dimensions) || !dimensions.every(isRecord)) {
    throw new EvalDetailsError("dimensions must be an array of objects");
  }
  if (checks.length === 0 && dimensions.length === 0) throw new EvalDetailsError("no check and no dimension");
  assertNames(checks, "checks");
  assertNames(dimensions, "dimensions");
  for (const c of checks) {
    if (typeof c.passed !== "boolean") throw new EvalDetailsError(`check "${c.name}": passed must be a boolean`);
  }
  for (const d of dimensions) {
    if (d.scale !== 1 && d.scale !== 2) throw new EvalDetailsError(`dimension "${d.name}": scale must be 1 or 2`);
    if (!Number.isInteger(d.score) || (d.score as number) < 0 || (d.score as number) > d.scale) {
      throw new EvalDetailsError(`dimension "${d.name}": score must be an integer in [0, ${d.scale}]`);
    }
  }
  if (cost !== null && !(isRecord(cost) && (cost.usd === null || isNonNegative(cost.usd)))) {
    throw new EvalDetailsError("cost must be null or { usd: number >= 0 | null }");
  }
  if (latency !== null && !(isRecord(latency) && (latency.durationMs === null || isNonNegative(latency.durationMs)))) {
    throw new EvalDetailsError("latency must be null or { durationMs: number >= 0 | null }");
  }
}

/** Validates `details` and scores it: hard checks first, then the rubric. Cost and latency never count. */
export function scoreEval(details: unknown): EvalScore {
  assertEvalDetails(details);
  if (details.checks.some((c) => !c.passed)) return { status: "fail", score: null, valid: false };
  if (details.dimensions.length === 0) return { status: "pass", score: 1, valid: true };
  const sum = details.dimensions.reduce((acc, d) => acc + d.score / d.scale, 0);
  return { status: "pass", score: sum / details.dimensions.length, valid: true };
}
