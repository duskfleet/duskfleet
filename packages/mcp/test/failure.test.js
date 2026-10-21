/**
 * classifyFailure: structured failure codes from the result line's fields and a failed
 * run's error text, never from a successful run's prose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import { classifyFailure, parseResetTime } from "@duskfleet/core";

const endedAt = new Date("2026-10-21T10:00:00Z");
const failed = (error, extra = {}) =>
  classifyFailure({
    outcome: "failed",
    error,
    terminalReason: null,
    subtype: null,
    stopReason: null,
    endedAt,
    ...extra,
  });

test("auth_required, with the login URL when the message gives one", () => {
  assert.deepEqual(failed("Invalid API key · Please run /login"), {
    code: "auth_required",
    family: "setup",
    detail: null,
  });
  assert.deepEqual(failed("Not logged in. Visit https://claude.ai/oauth/authorize?code=true. Then retry."), {
    code: "auth_required",
    family: "setup",
    detail: { loginUrl: "https://claude.ai/oauth/authorize?code=true" },
  });
  assert.equal(failed("OAuth token has expired")?.code, "auth_required");
});

test("model_not_found", () => {
  const r = failed(
    "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it.",
  );
  assert.equal(r?.code, "model_not_found");
  assert.equal(r?.family, "setup");
  assert.equal(
    failed('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: x"}}')?.code,
    "model_not_found",
  );
});

test("max_turns_exhausted comes from the subtype or terminal reason, not from text", () => {
  assert.equal(failed("exit code 1", { subtype: "error_max_turns" })?.code, "max_turns_exhausted");
  assert.equal(failed(null, { terminalReason: "max_turns" })?.family, "limit");
});

test("provider_quota with retryNotBefore from the reset time", () => {
  assert.deepEqual(failed("Claude AI usage limit reached|1792594800"), {
    code: "provider_quota",
    family: "limit",
    detail: { retryNotBefore: "2026-10-21T15:00:00.000Z" },
  });
  const r = failed("You've hit your limit · resets 3pm (Europe/London)");
  assert.equal(r?.code, "provider_quota");
  // 10:00Z is 11:00 in London (BST): 3pm London = 14:00Z the same day.
  assert.equal(r?.detail?.retryNotBefore, "2026-10-21T14:00:00.000Z");
  assert.deepEqual(failed("5-hour limit reached"), { code: "provider_quota", family: "limit", detail: null });
});

test("transient_upstream for 429 / 503 / 529 / overloaded", () => {
  for (const e of [
    "API Error: 529 Overloaded",
    'API Error: 503 {"type":"error"}',
    "API Error: 429 rate_limit_error",
    "API Error: 429 Rate limit reached for requests",
    'API Error: {"type":"overloaded_error"}',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"exceeded your rate limit quota"}}',
  ]) {
    assert.deepEqual(failed(e), { code: "transient_upstream", family: "transient", detail: null }, e);
  }
});

test("refusal from stop_reason, even on a completed run", () => {
  const r = classifyFailure({
    outcome: "completed",
    error: null,
    terminalReason: "completed",
    subtype: "success",
    stopReason: "refusal",
    endedAt,
  });
  assert.deepEqual(r, { code: "refusal", family: "refusal", detail: null });
  assert.equal(failed("exit code 1", { stopReason: "refusal" })?.code, "refusal");
});

test("a cancelled or timed-out run is never a refusal", () => {
  for (const outcome of ["cancelled", "timed_out"]) {
    const r = classifyFailure({
      outcome,
      error: null,
      terminalReason: null,
      subtype: null,
      stopReason: "refusal",
      endedAt,
    });
    assert.equal(r, null, outcome);
  }
});

test("a completed, cancelled or timed-out run's text is never classified", () => {
  for (const outcome of ["completed", "cancelled", "timed_out"]) {
    const r = classifyFailure({
      outcome,
      error: "Not logged in · Please run /login; API Error: 529 Overloaded",
      terminalReason: null,
      subtype: null,
      stopReason: "end_turn",
      endedAt,
    });
    assert.equal(r, null, outcome);
  }
});

test("an unknown failure has no code", () => {
  assert.equal(failed("API Error: something went wrong"), null);
  assert.equal(failed(null), null);
  assert.equal(failed("Reached maximum budget ($5)", { terminalReason: "budget_exhausted" }), null);
});

test("parseResetTime: epoch, ISO, wall clock in a zone, next occurrence", () => {
  const now = new Date("2026-10-21T16:00:00Z");
  assert.equal(parseResetTime("limit reached|1792594800", now), "2026-10-21T15:00:00.000Z");
  assert.equal(parseResetTime("resets at 2026-10-22T08:00:00Z", now), "2026-10-22T08:00:00.000Z");
  // 3pm New York (EDT, UTC-4) = 19:00Z, still ahead of 16:00Z.
  assert.equal(parseResetTime("resets 3pm (America/New_York)", now), "2026-10-21T19:00:00.000Z");
  // 9:30 UTC already passed today: tomorrow.
  assert.equal(parseResetTime("resets at 9:30am (UTC)", now), "2026-10-22T09:30:00.000Z");
  assert.equal(parseResetTime("resets at 12am (UTC)", now), "2026-10-22T00:00:00.000Z");
  assert.equal(parseResetTime("resets 3 times a day", now), null);
  assert.equal(parseResetTime("resets 3pm (Not/AZone)", now), null);
  assert.equal(parseResetTime("limit reached", now), null);
});
