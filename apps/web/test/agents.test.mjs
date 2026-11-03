import assert from "node:assert/strict";
import { test } from "node:test";
import { agentState, cleanTone } from "../lib/agents.ts";

test("agentState: running beats an auto-pause, an auto-pause beats needs review", () => {
  assert.equal(agentState({ running: true, autoPaused: true, lastNeedsReview: true }), "running");
  assert.equal(agentState({ running: false, autoPaused: true, lastNeedsReview: true }), "paused");
  assert.equal(agentState({ running: false, autoPaused: false, lastNeedsReview: true }), "review");
  assert.equal(agentState({ running: false, autoPaused: false, lastNeedsReview: false }), "idle");
});

test("cleanTone: >= 90 ok, 70 to 89 warn, below 70 bad, nothing finished no tone", () => {
  assert.equal(cleanTone(9, 10), "ok");
  assert.equal(cleanTone(89, 100), "warn");
  assert.equal(cleanTone(7, 10), "warn");
  assert.equal(cleanTone(69, 100), "bad");
  assert.equal(cleanTone(0, 3), "bad");
  assert.equal(cleanTone(0, 0), "");
});
