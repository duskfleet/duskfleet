import assert from "node:assert/strict";
import { test } from "node:test";
import { agentChips, agoText, lastRunNeedsReview } from "../lib/projects.ts";

test("agentChips: two chips, then +N for the rest", () => {
  assert.deepEqual(agentChips([]), { shown: [], more: 0 });
  assert.deepEqual(agentChips(["a", "b"]), { shown: ["a", "b"], more: 0 });
  assert.deepEqual(agentChips(["a", "b", "c", "d"]), { shown: ["a", "b"], more: 2 });
});

test("lastRunNeedsReview: only a completed run with a stored reason, never a running or cancelled one", () => {
  assert.equal(lastRunNeedsReview(null), false);
  assert.equal(lastRunNeedsReview({ status: "completed", reviewReasons: [] }), false);
  assert.equal(lastRunNeedsReview({ status: "completed", reviewReasons: ["permission_denied"] }), true);
  assert.equal(lastRunNeedsReview({ status: "running", reviewReasons: [] }), false);
  assert.equal(lastRunNeedsReview({ status: "cancelled", reviewReasons: [] }), false);
});

test("agoText: relative ages get 'ago', now and dates stay", () => {
  assert.equal(agoText("now"), "now");
  assert.equal(agoText("40 min"), "40 min ago");
  assert.equal(agoText("3 d"), "3 d ago");
  assert.equal(agoText("4 Oct"), "4 Oct");
});
