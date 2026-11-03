// Evals foundation: the evals.details schema, the scoring order, isolation from runs.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EvalDetailsError, EvalRepository, openDatabase, runEvaluator, scoreEval } from "@duskfleet/core";

const details = (over = {}) => ({ schema: 1, checks: [], dimensions: [], cost: null, latency: null, ...over });
const check = (name, passed) => ({ name, passed });
const dim = (name, scale, score) => ({ name, scale, score });

function seeded() {
  const dir = mkdtempSync(path.join(tmpdir(), "df-evals-"));
  const db = openDatabase(dir);
  db.prepare(
    `INSERT INTO runs (id, agent_id, project_path, prompt, status, created_at, permission_mode, command_json)
     VALUES ('r1', 'a', '/p', 'x', 'completed', '2026-10-01T00:00:00.000Z', 'dontAsk', '[]')`,
  ).run();
  const runsRow = () => JSON.stringify(db.prepare("SELECT * FROM runs WHERE id = 'r1'").get());
  return {
    db,
    repo: new EvalRepository(db),
    runsRow,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("all hard checks passed and no dimension scores 1", () => {
  assert.deepEqual(scoreEval(details({ checks: [check("tests", true)] })), { status: "pass", score: 1, valid: true });
});

test("a failed hard check makes the run invalid: fail, null score, rubric not scored", () => {
  const d = details({ checks: [check("tests", true), check("build", false)], dimensions: [dim("clarity", 2, 2)] });
  assert.deepEqual(scoreEval(d), { status: "fail", score: null, valid: false });
});

test("rubric score is the mean of score/scale over 0-1 and 0-2 dimensions", () => {
  const d = details({ checks: [check("tests", true)], dimensions: [dim("a", 2, 1), dim("b", 1, 1), dim("c", 2, 0)] });
  assert.deepEqual(scoreEval(d), { status: "pass", score: 0.5, valid: true });
});

test("cost and latency never change the score", () => {
  const base = details({ dimensions: [dim("a", 2, 1)] });
  const costly = { ...base, cost: { usd: 12.5 }, latency: { durationMs: 900000 } };
  assert.deepEqual(scoreEval(costly), scoreEval(base));
});

test("malformed details are refused", () => {
  const bad = [
    null,
    details({ schema: 2, checks: [check("x", true)] }),
    details(),
    details({ checks: [check("x", "yes")] }),
    details({ checks: [check("x", true), check("x", true)] }),
    details({ checks: [check("", true)] }),
    details({ dimensions: [dim("a", 3, 1)] }),
    details({ dimensions: [dim("a", 2, 3)] }),
    details({ dimensions: [dim("a", 2, 0.5)] }),
    details({ checks: [check("x", true)], cost: { usd: -1 } }),
    details({ checks: [check("x", true)], latency: { durationMs: "fast" } }),
  ];
  for (const value of bad) assert.throws(() => scoreEval(value), EvalDetailsError, JSON.stringify(value));
});

test("record stores status and score from the schema, and never touches runs", () => {
  const { repo, runsRow, cleanup } = seeded();
  try {
    const before = runsRow();
    const d = details({ checks: [check("tests", true)], dimensions: [dim("a", 2, 2)], cost: { usd: 0.01 } });
    repo.record("r1", "rubric", "llm", { details: d });
    repo.record("r1", "build", "deterministic", { status: "skipped", message: "no build script" });
    assert.equal(runsRow(), before);
    const rows = repo.forRun("r1");
    assert.deepEqual(
      rows.map((r) => [r.name, r.status, r.score]),
      [
        ["rubric", "pass", 1],
        ["build", "skipped", null],
      ],
    );
    assert.deepEqual(rows[0].details, d);
    assert.deepEqual(rows[1].details, { message: "no build script" });
    assert.throws(() => repo.record("r1", "bad", "deterministic", { details: details() }), EvalDetailsError);
    assert.equal(repo.forRun("r1").length, 2);
  } finally {
    cleanup();
  }
});

test("runEvaluator records a throwing or malformed evaluator as error", async () => {
  const { repo, runsRow, cleanup } = seeded();
  try {
    const before = runsRow();
    const throws = {
      name: "boom",
      kind: "deterministic",
      evaluate: async () => {
        throw new Error("kaboom");
      },
    };
    const malformed = { name: "shape", kind: "deterministic", evaluate: async () => ({ details: details() }) };
    assert.equal((await runEvaluator(repo, throws, "r1")).status, "error");
    const r = await runEvaluator(repo, malformed, "r1");
    assert.equal(r.status, "error");
    assert.match(r.details.message, /no check and no dimension/);
    assert.equal(runsRow(), before);
  } finally {
    cleanup();
  }
});

test("an LLM evaluator needs its own positive maxBudgetUsd", async () => {
  const { repo, cleanup } = seeded();
  try {
    let called = false;
    const evaluate = async () => {
      called = true;
      return { details: details({ dimensions: [dim("a", 1, 1)] }) };
    };
    for (const maxBudgetUsd of [undefined, 0, -1, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        runEvaluator(repo, { name: "judge", kind: "llm", maxBudgetUsd, evaluate }, "r1"),
        /maxBudgetUsd/,
      );
    }
    assert.equal(called, false);
    const ok = await runEvaluator(repo, { name: "judge", kind: "llm", maxBudgetUsd: 0.05, evaluate }, "r1");
    assert.deepEqual([ok.status, ok.score], ["pass", 1]);
  } finally {
    cleanup();
  }
});

test("evals source never writes the runs table", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "evals");
  for (const file of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(src, /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+runs\b/i, file);
    assert.doesNotMatch(src, /from\s+["']\.\.\/(orchestration|storage)\//, file);
  }
});
