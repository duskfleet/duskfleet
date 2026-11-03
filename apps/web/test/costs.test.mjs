import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetPerBucket,
  costRows,
  costStacks,
  fmtUsd2,
  fmtUsdShort,
  moneyAxis,
  resolveTicks,
  timesText,
  toggleTick,
} from "../lib/costs.ts";

const series = [
  { key: "a", values: [3, 1], total: 4 },
  { key: "b", values: [1, 1], total: 2 },
  { key: "c", values: [0, 1], total: 1 },
];
const totals = [4, 3];

test("costRows ranks by spend, joins finished runs, keeps run-only keys", () => {
  const rows = costRows(
    series,
    new Map([
      ["a", 8],
      ["c", 1],
      ["d", 2],
    ]),
  );
  assert.deepEqual(
    rows.map((r) => r.key),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(rows[0], { key: "a", spent: 4, runs: 8, share: 4 / 7, avg: 0.5 });
  assert.equal(rows[1].avg, null);
  assert.deepEqual(rows[3], { key: "d", spent: 0, runs: 2, share: 0, avg: 0 });
});

test("resolveTicks: no param = the top 5 spenders, an empty param = none, unknown keys dropped", () => {
  const rows = costRows(
    Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, values: [7 - i], total: 7 - i })),
    new Map(),
  );
  assert.deepEqual(resolveTicks(null, rows), ["k0", "k1", "k2", "k3", "k4"]);
  assert.deepEqual(resolveTicks([], rows), []);
  assert.deepEqual(resolveTicks(["k6", "zz", "k1"], rows), ["k1", "k6"]);
});

test("toggleTick keeps rank order and writes an emptied set as [''] for ?agent=", () => {
  const rows = costRows(series, new Map());
  assert.deepEqual(toggleTick(["b"], "a", rows), ["a", "b"]);
  assert.deepEqual(toggleTick(["a"], "a", rows), [""]);
});

test("costStacks: nothing ticked is one faint total", () => {
  assert.deepEqual(costStacks(series, totals, []), [{ key: "__total", tone: "faint", values: [4, 3], row: null }]);
});

test("costStacks: one ticked is the accent plus others", () => {
  const stacks = costStacks(series, totals, ["b"]);
  assert.deepEqual(
    stacks.map((s) => [s.key, s.tone, s.values]),
    [
      ["b", "accent", [1, 1]],
      ["__others", "others", [3, 2]],
    ],
  );
});

test("costStacks: several ticked in rank order, the first in the accent; no others when all are ticked", () => {
  const stacks = costStacks(series, totals, ["a", "b", "c"]);
  assert.deepEqual(
    stacks.map((s) => [s.key, s.tone]),
    [
      ["a", "accent"],
      ["b", "faint"],
      ["c", "faint"],
    ],
  );
});

test("fmtUsd2 and timesText", () => {
  assert.equal(fmtUsd2(9.8412), "$9.84");
  assert.equal(fmtUsd2(0), "$0.00");
  assert.equal(timesText(0.32, 0.12), "2.7×");
  assert.equal(timesText(1, 0), null);
});

test("fmtUsdShort keeps bar totals short", () => {
  assert.equal(fmtUsdShort(0), "$0");
  assert.equal(fmtUsdShort(0.4213), "$0.42");
  assert.equal(fmtUsdShort(0.1), "$0.1");
  assert.equal(fmtUsdShort(3.46), "$3.5");
  assert.equal(fmtUsdShort(37.6), "$38");
});

test("moneyAxis rounds up to about three steps, fractions included", () => {
  assert.deepEqual(moneyAxis(50), { max: 60, ticks: [0, 20, 40, 60] });
  assert.deepEqual(moneyAxis(0.27), { max: 0.3, ticks: [0, 0.1, 0.2, 0.3] });
  assert.deepEqual(moneyAxis(0), { max: 0.5, ticks: [0, 0.5] });
  assert.deepEqual(moneyAxis(40), { max: 40, ticks: [0, 20, 40] });
});

test("budgetPerBucket scales a monthly budget to days and weeks", () => {
  assert.equal(budgetPerBucket(50, "month"), 50);
  assert.equal(Math.round(budgetPerBucket(365, "day")), 12);
  assert.equal(Math.round(budgetPerBucket(365, "week")), 84);
});
