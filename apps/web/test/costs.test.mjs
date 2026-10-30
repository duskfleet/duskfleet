import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetPerBucket, fmtUsdShort, moneyAxis } from "../lib/costs.ts";

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
