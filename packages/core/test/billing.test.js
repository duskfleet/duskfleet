/** costLabels: the wording of a cost sum follows the billing types of the runs in view. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { costBasis, costLabels, SUBSCRIPTION_NOTE } from "@duskfleet/core";

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

test("nothing spent yet keeps the plain wording", () => {
  assert.equal(costBasis({ apiUsd: 0, subscriptionUsd: 0 }), "api");
  assert.equal(costLabels({ apiUsd: 0, subscriptionUsd: 0 }).heading, "Spent");
});
