/** costLabels: the wording of a cost sum follows the billing types of the runs in view. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { costBasis, costLabels, costTotals, costTotalsLine, runCostLabel, SUBSCRIPTION_NOTE } from "@duskfleet/core";

test("all api runs: billed money, plain Spent", () => {
  const l = costLabels({ apiUsd: 4.2, subscriptionUsd: 0 });
  assert.equal(l.basis, "api");
  assert.equal(l.heading, "Spent");
  assert.equal(l.note, null);
  assert.equal(l.column, "Cost");
  assert.equal(l.verb, "spent");
});

test("all subscription runs: usage at API value, included in the subscription", () => {
  const l = costLabels({ apiUsd: 0, subscriptionUsd: 376 });
  assert.equal(l.basis, "subscription");
  assert.equal(l.heading, "Usage (API value)");
  assert.equal(l.note, SUBSCRIPTION_NOTE);
  assert.equal(l.column, "API value");
  assert.match(l.verb, /API value/);
});

test("mixed runs keep billed and API value apart", () => {
  const l = costLabels({ apiUsd: 1, subscriptionUsd: 2 });
  assert.equal(l.basis, "mixed");
  assert.equal(l.heading, "Spent and usage");
  assert.match(l.note ?? "", /billed/);
  assert.equal(l.column, "Cost / API value");
});

test("runCostLabel: only an api run's cost is billed; unknown counts as API value", () => {
  assert.equal(runCostLabel("api"), "Cost");
  assert.equal(runCostLabel("subscription"), "API value");
  assert.equal(runCostLabel(null), "API value");
});

test("costTotals splits by billing type, rounds, and carries the wording", () => {
  const t = costTotals([
    { costUsd: 0.1, billingType: "subscription" },
    { costUsd: 0.2, billingType: null },
    { costUsd: null, billingType: "subscription" },
  ]);
  assert.equal(t.runs, 3);
  assert.equal(t.apiUsd, 0);
  assert.equal(t.subscriptionUsd, 0.3);
  assert.equal(t.heading, "Usage (API value)");
  assert.equal(costTotalsLine(t), `Usage (API value): $0.3 over 3 runs, ${SUBSCRIPTION_NOTE}`);

  const api = costTotals([{ costUsd: 1.5, billingType: "api" }]);
  assert.equal(costTotalsLine(api), "Spent: $1.5 over 1 run");

  const mixed = costTotals([
    { costUsd: 1, billingType: "api" },
    { costUsd: 2, billingType: "subscription" },
  ]);
  assert.equal(mixed.basis, "mixed");
  assert.equal(costTotalsLine(mixed), "Spent and usage: $1 billed, $2 API value over 2 runs");

  assert.equal(costTotalsLine(costTotals([])), "Spent: $0 over 0 runs");
});

test("nothing spent yet keeps the plain wording", () => {
  assert.equal(costBasis({ apiUsd: 0, subscriptionUsd: 0 }), "api");
  assert.equal(costLabels({ apiUsd: 0, subscriptionUsd: 0 }).heading, "Spent");
});
