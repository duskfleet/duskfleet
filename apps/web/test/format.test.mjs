import assert from "node:assert/strict";
import { test } from "node:test";
import { runTitle, shortModel, shortPath, tildePath, tildeText } from "../lib/format.ts";
import { badgeVerdict } from "../lib/status.ts";

test("runTitle takes the first non-empty line and strips markdown markers", () => {
  assert.equal(runTitle("\n\n  ## Fix the parser  \nmore text"), "Fix the parser");
  assert.equal(runTitle("**Bold** task"), "Bold task");
  assert.equal(runTitle("- list item"), "list item");
  assert.equal(runTitle("* star item"), "star item");
});

test("runTitle says so when the prompt is empty", () => {
  assert.equal(runTitle(""), "(empty prompt)");
  assert.equal(runTitle("  \n\t\n"), "(empty prompt)");
});

test("runTitle keeps a short line and cuts a long one at a word boundary", () => {
  const exact = "x".repeat(80);
  assert.equal(runTitle(exact), exact);
  const long = "Review the open pull request, then reply to every thread and hand it back to the reviewer agent";
  const title = runTitle(long);
  assert.equal(title, "Review the open pull request, then reply to every thread and hand it back to…");
  assert.ok(title.length <= 81);
  // trailing punctuation before the cut is dropped
  assert.equal(runTitle("aaaa bbbb, cccc", 10), "aaaa bbbb…");
});

test("runTitle cuts mid-word when the last space is too early", () => {
  assert.equal(runTitle(`ab ${"c".repeat(40)}`, 20), `ab ${"c".repeat(17)}…`);
});

test("a completed run with a permission denial needs review (amber), never plain green", () => {
  const v = badgeVerdict("completed", ["permission_denied"]);
  assert.equal(v.label, "needs review");
  assert.equal(v.cls, "attention");
  assert.equal(v.title, "completed · needs review: permission denied");
});

test("a clean completed run stays green", () => {
  assert.deepEqual(badgeVerdict("completed", []), { label: "completed", cls: "completed", title: "completed" });
});

test("every review reason turns a completed run amber and lands in the title", () => {
  const v = badgeVerdict("completed", ["context_exhausted", "empty_run"]);
  assert.equal(v.cls, "attention");
  assert.equal(v.title, "completed · needs review: context exhausted · no work done");
});

test("a failed or timed-out run keeps its own colour; the reasons go in the title", () => {
  const failed = badgeVerdict("failed", ["failed", "nonzero_exit"]);
  assert.equal(failed.label, "failed");
  assert.equal(failed.cls, "failed");
  assert.equal(failed.title, "failed · needs review: failed · non-zero exit code");
  const timedOut = badgeVerdict("timed_out", ["timed_out"]);
  assert.equal(timedOut.label, "timed out");
  assert.equal(timedOut.cls, "timed_out");
  assert.equal(timedOut.title, "timed out · needs review: timed out");
});

test("running and cancelled runs are never needs review", () => {
  assert.equal(badgeVerdict("running", []).cls, "running");
  assert.equal(badgeVerdict("cancelled", []).label, "cancelled");
});

test("tildePath replaces the home prefix only on a path boundary", () => {
  const home = "/home/me";
  assert.equal(tildePath("/home/me/Documents/x", home), "~/Documents/x");
  assert.equal(tildePath("/home/me", home), "~");
  assert.equal(tildePath("/home/meadow/x", home), "/home/meadow/x");
  assert.equal(tildePath("/srv/x", home), "/srv/x");
  assert.equal(tildePath("/home/me/x", ""), "/home/me/x");
  assert.equal(tildePath(null, home), "–");
  assert.equal(tildePath(undefined, home), "–");
  assert.equal(tildePath("", home), "–");
});

test("tildeText replaces every occurrence of home inside free text", () => {
  const home = "/home/me";
  assert.equal(tildeText("cd /home/me/a && ls /home/me/b", home), "cd ~/a && ls ~/b");
  assert.equal(tildeText("HOME=/home/me", home), "HOME=~");
  assert.equal(tildeText("/home/me/x", ""), "/home/me/x");
});

test("shortPath keeps the last two segments", () => {
  assert.equal(shortPath("/home/me/projects/app"), "projects/app");
  assert.equal(shortPath("/app/"), "app");
  assert.equal(shortPath("/"), "/");
});

test("shortModel turns full model ids into family and version", () => {
  assert.equal(shortModel("claude-haiku-5-5"), "haiku 5.5");
  assert.equal(shortModel("claude-haiku-4-5-20251001"), "haiku 4.5");
  assert.equal(shortModel("claude-opus-5"), "opus 5");
  assert.equal(shortModel("claude-sonnet-4-20250514"), "sonnet 4");
  assert.equal(shortModel("haiku"), "haiku");
  assert.equal(shortModel(null), "default");
  assert.equal(shortModel(undefined), "default");
  assert.equal(shortModel(""), "default");
});
