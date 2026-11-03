// scripts/pr-gate.mjs: the selection of the closed-item cleanup pass (#359). Pure, no gh call:
// importing the script runs nothing, main() only runs when it is executed directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closedFlowLabels } from "../../../scripts/pr-gate.mjs";

const now = Date.parse("2026-11-03T12:00:00Z");
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();
const labels = (...names) => names.map((name) => ({ name }));

test("a closed issue loses every flow label and keeps area and priority", () => {
  const issue = {
    number: 1,
    state: "closed",
    closed_at: daysAgo(1),
    labels: labels("area: tests", "flow: in-progress", "priority: low", "flow: needs-human"),
  };
  assert.deepEqual(closedFlowLabels(issue, { now }), ["flow: in-progress", "flow: needs-human"]);
});

test("a merged PR loses its review labels", () => {
  const pr = {
    number: 2,
    state: "closed",
    closed_at: daysAgo(0.1),
    pull_request: { merged_at: daysAgo(0.1) },
    labels: labels("flow: ready-to-merge", "dependencies"),
  };
  assert.deepEqual(closedFlowLabels(pr, { now }), ["flow: ready-to-merge"]);
});

test("a PR closed without a merge is cleared too", () => {
  const pr = {
    number: 3,
    state: "closed",
    closed_at: daysAgo(2),
    pull_request: { merged_at: null },
    labels: labels("flow: changes-requested", "flow: in-review"),
  };
  assert.deepEqual(closedFlowLabels(pr, { now }), ["flow: changes-requested", "flow: in-review"]);
});

test("open items are never touched", () => {
  const issue = { number: 4, state: "open", closed_at: null, labels: labels("flow: in-progress") };
  assert.deepEqual(closedFlowLabels(issue, { now }), []);
});

test("items closed more than 30 days ago are left alone", () => {
  const issue = { number: 5, state: "closed", closed_at: daysAgo(31), labels: labels("flow: ready") };
  assert.deepEqual(closedFlowLabels(issue, { now }), []);
  assert.deepEqual(closedFlowLabels(issue, { now, days: 40 }), ["flow: ready"]);
});

test("a closed item without flow labels, or without a close date, needs nothing", () => {
  assert.deepEqual(
    closedFlowLabels({ number: 6, state: "closed", closed_at: daysAgo(1), labels: labels("area: web") }, { now }),
    [],
  );
  assert.deepEqual(
    closedFlowLabels({ number: 7, state: "closed", closed_at: null, labels: labels("flow: ready") }, { now }),
    [],
  );
});

test("a label prefix match is exact: no flow-like names", () => {
  const issue = {
    number: 8,
    state: "closed",
    closed_at: daysAgo(1),
    labels: [{ name: "workflow: ci" }, { name: "flow:ready" }, "flow: needs-review"],
  };
  assert.deepEqual(closedFlowLabels(issue, { now }), ["flow: needs-review"]);
});
