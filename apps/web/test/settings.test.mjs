import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldError, formatValue, fromDraft, SECTIONS, toDraft } from "../lib/settings.ts";

const field = (key) => SECTIONS.flatMap((s) => s.fields).find((f) => f.key === key);

test("integer fields follow the loader's bounds", () => {
  const runs = field("max_concurrent_runs");
  assert.equal(fieldError(runs, "2"), null);
  assert.match(fieldError(runs, "0"), /Whole number, 1 or more/);
  assert.match(fieldError(runs, "2.5"), /\(2\.5 is not\)/);
  assert.match(fieldError(runs, ""), /Whole number/);
  const tick = field("scheduler.tick_seconds");
  assert.equal(fieldError(tick, "300"), null);
  assert.match(fieldError(tick, "4"), /5 to 300/);
  assert.equal(fieldError(field("scheduler.auto_pause_after"), "0"), null);
});

test("positive numbers accept decimals, not zero", () => {
  const budget = field("claude.default_max_budget_usd");
  assert.equal(fieldError(budget, "2.5"), null);
  assert.match(fieldError(budget, "0"), /above 0/);
});

test("setting_sources: null means all three, saved in the file's order", () => {
  const sources = field("claude.setting_sources");
  assert.deepEqual(toDraft(sources, null), ["project", "local", "user"]);
  assert.deepEqual(toDraft(sources, ["local", "project"]), ["project", "local"]);
  assert.deepEqual(fromDraft(sources, ["local", "project"]), ["project", "local"]);
  assert.deepEqual(sources.resetTo, ["project", "local"]);
  assert.equal(sources.restart, true);
});

test("empty text and agent become null; values format for the dialog", () => {
  assert.equal(fromDraft(field("claude.binary"), "  "), null);
  assert.equal(fromDraft(field("default_agent"), ""), null);
  assert.deepEqual(fromDraft(field("allowed_project_roots"), [" ~/p ", ""]), ["~/p"]);
  assert.equal(formatValue(field("claude.strict_mcp_config"), true), "on");
  assert.equal(formatValue(field("allowed_project_roots"), []), "no roots");
  assert.equal(fromDraft(field("max_concurrent_per_agent"), "2"), 2);
});

test("only claude.binary and claude.setting_sources need a restart", () => {
  const restart = SECTIONS.flatMap((s) => s.fields)
    .filter((f) => f.restart)
    .map((f) => f.key);
  assert.deepEqual(restart.sort(), ["claude.binary", "claude.setting_sources"]);
});
