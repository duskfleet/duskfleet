import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessInfo } from "../lib/harness.ts";

const host = new Map([
  ["claude", null],
  ["copilot", "GitHub Copilot CLI not found"],
]);

test("harnessInfo: no harness set is claude; empty counts as unset", () => {
  assert.deepEqual(harnessInfo(undefined, host), { name: "claude", missing: null });
  assert.deepEqual(harnessInfo(null, host), { name: "claude", missing: null });
  assert.deepEqual(harnessInfo("", host), { name: "claude", missing: null });
});

test("harnessInfo: a shipped harness registered on this host is not marked", () => {
  assert.deepEqual(harnessInfo("copilot", new Map([["copilot", null]])), { name: "copilot", missing: null });
});

test("harnessInfo: a shipped harness whose CLI is missing is not installed, with the reason", () => {
  const info = harnessInfo("copilot", host);
  assert.equal(info.missing?.label, "not installed");
  assert.match(info.missing?.reason ?? "", /^GitHub Copilot CLI not found; set copilot\.binary in duskfleet\.yaml/);
});

test("harnessInfo: a name with no adapter is not registered", () => {
  assert.deepEqual(harnessInfo("codex", host).missing, {
    label: "not registered",
    reason: "harness codex is not registered: its runs are refused",
  });
});
