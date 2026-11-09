/**
 * The CLI's human-output building blocks (packages/mcp/src/render): exact plain lines with
 * `color: false`, and the escape sequence of each role with `color: true`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badge,
  fmtDuration,
  fmtPercent,
  fmtRelative,
  fmtUsd,
  kv,
  oneLine,
  paint,
  ROLES,
  section,
  sections,
  table,
} from "../dist/render/index.js";

const plain = (width = 100) => ({ color: false, width });

const COLUMNS = [{ header: "name" }, { header: "n", align: "right", priority: 1 }, { header: "note", flex: true }];
const ROWS = [
  ["a", "1", "a fairly long note text"],
  ["bbb", "22", "x"],
];

test("table: padded columns, numbers right-aligned, no trailing spaces", () => {
  assert.deepEqual(table(COLUMNS, ROWS, plain()), [
    "name   n  note",
    "a      1  a fairly long note text",
    "bbb   22  x",
  ]);
});

test("table: the flexible column is cut with … to fit the width", () => {
  const lines = table(COLUMNS, ROWS, plain(30));
  assert.deepEqual(lines, ["name   n  note", "a      1  a fairly long note …", "bbb   22  x"]);
  assert.ok(lines.every((l) => l.length <= 30));
});

test("table: the lowest-priority column is dropped before the flexible one goes below its minimum", () => {
  assert.deepEqual(table(COLUMNS, ROWS, plain(20)), ["name  note", "a     a fairly long…", "bbb   x"]);
});

test("kv: aligned keys, null values left out", () => {
  assert.deepEqual(
    kv(
      [
        ["id", "abc"],
        ["skipped", null],
        ["long key", { text: "v", role: "ok" }],
      ],
      plain(),
    ),
    ["id        abc", "long key  v"],
  );
});

test("section and sections: indented lines, blank line between blocks, empty ones skipped", () => {
  assert.deepEqual(section("Run", ["a", ""], plain()), ["Run", "  a", ""]);
  assert.deepEqual(section("Empty", [], plain()), []);
  assert.deepEqual(sections([["x"], [], ["y"]]), ["x", "", "y"]);
});

test("formatting helpers", () => {
  assert.equal(fmtDuration(850), "850ms");
  assert.equal(fmtDuration(12_345), "12.3s");
  assert.equal(fmtDuration(245_000), "4m 05s");
  assert.equal(fmtDuration(7_380_000), "2h 03m");
  assert.equal(fmtDuration(null), "-");

  const now = new Date("2026-11-09T12:00:00Z");
  assert.equal(fmtRelative("2026-11-09T11:59:40Z", now), "just now");
  assert.equal(fmtRelative("2026-11-09T11:55:00Z", now), "5m ago");
  assert.equal(fmtRelative("2026-11-09T09:00:00Z", now), "3h ago");
  assert.equal(fmtRelative("2026-11-07T12:00:00Z", now), "2d ago");
  assert.equal(fmtRelative("2026-09-01T08:00:00Z", now), "2026-09-01");
  assert.equal(fmtRelative("2026-11-09T12:04:00Z", now), "in 4m");
  assert.equal(fmtRelative(null, now), "-");

  assert.equal(fmtUsd(0.0123), "$0.0123");
  assert.equal(fmtUsd(1.25), "$1.25");
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(null), "-");
  assert.equal(fmtPercent(0.8), "80%");
  assert.equal(fmtPercent(null), "-");

  assert.equal(oneLine("a\n   b "), "a b");
  assert.equal(oneLine("x".repeat(10), 8), "xxxxx...");
  assert.equal(badge("timed_out", plain()), "timed out");
});

test("paint: plain text without colour, one escape sequence per role with it", () => {
  const expected = {
    ok: "\x1b[32mx\x1b[39m",
    warn: "\x1b[33mx\x1b[39m",
    bad: "\x1b[31mx\x1b[39m",
    run: "\x1b[36mx\x1b[39m",
    accent: "\x1b[35mx\x1b[39m",
    muted: "\x1b[2mx\x1b[22m",
    faint: "\x1b[90mx\x1b[39m",
    heading: "\x1b[1mx\x1b[22m",
  };
  assert.deepEqual([...ROLES].sort(), Object.keys(expected).sort());
  for (const role of ROLES) {
    assert.equal(paint(role, "x", { color: false }), "x");
    assert.equal(paint(role, "x", { color: true }), expected[role], role);
  }
  assert.equal(badge("failed", { color: true, width: 100 }), expected.bad);
});
