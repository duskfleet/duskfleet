/**
 * The CLI's human-output building blocks (packages/mcp/src/render): exact plain lines with
 * `color: false`, and the SGR codes of each DS-33 role with `color: true`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badge,
  costCell,
  cutMiddle,
  fmtAge,
  fmtCents,
  fmtCost,
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
  shortModel,
  table,
  tildePath,
} from "../dist/render/index.js";

const plain = (width = 100) => ({ color: false, width });

const COLUMNS = [
  { header: "NAME", width: 5 },
  { header: "N", width: 3, align: "right", priority: 1 },
  { header: "NOTE", width: 10, flex: true, min: 6 },
];
const ROWS = [
  ["a", "1", "a fairly long note text"],
  ["bbbbbbb", "22", "x"],
];

test("table: design widths, numbers right-aligned, cells cut with …, no trailing spaces", () => {
  assert.deepEqual(table(COLUMNS, ROWS, plain()), [
    "NAME     N  NOTE",
    "a        1  a fairly long note text",
    "bbbb…   22  x",
  ]);
});

test("table: the flexible column gives way to its floor, then the lowest-priority column drops", () => {
  assert.deepEqual(table(COLUMNS, ROWS, plain(24)), ["NAME     N  NOTE", "a        1  a fairly lo…", "bbbb…   22  x"]);
  assert.deepEqual(table(COLUMNS, ROWS, plain(16)), ["NAME   NOTE", "a      a fairly…", "bbbb…  x"]);
});

test("table: a fill column takes the rest of the line", () => {
  const cols = [
    { header: "ID", width: 4 },
    { header: "TEXT", fill: true },
  ];
  assert.deepEqual(table(cols, [["ab", "x".repeat(30)]], plain(20)), ["ID    TEXT", `ab    ${"x".repeat(13)}…`]);
});

test("kv: bold labels padded to a width, null values left out", () => {
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
  assert.deepEqual(kv([["id", "abc"]], plain(), 6), ["id    abc"]);
  assert.equal(kv([["id", "abc"]], { color: true, width: 100 })[0], "\u001b[1mid\u001b[22m  abc");
});

test("section and sections: a bold title with a rule, indented lines, blank line between blocks", () => {
  assert.deepEqual(section("Run", ["a", ""], plain(20)), [`Run ${"─".repeat(16)}`, "  a", ""]);
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
  assert.equal(fmtAge("2026-11-09T11:58:00Z", now), "2m");
  assert.equal(fmtAge("2026-11-09T11:42:00Z", now), "18m");
  assert.equal(fmtAge("2026-11-09T09:00:00Z", now), "3h");
  assert.equal(fmtAge("2026-11-07T12:00:00Z", now), "2d");
  assert.equal(fmtAge("2026-11-10T09:00:00Z", now), "21h", "future ages read the same");

  assert.equal(fmtUsd(0.0123), "$0.0123");
  assert.equal(fmtUsd(1.25), "$1.25");
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(null), "-");
  assert.equal(fmtCost(0), "$0.00");
  assert.equal(fmtCost(0.0038), "<$0.01");
  assert.equal(fmtCost(0.0099), "<$0.01", "decided on the value, not on the rounded text");
  assert.equal(fmtCost(0.01), "$0.01");
  assert.equal(fmtCost(0.003 + 0.007), "$0.01", "a float sum a hair under a cent is a cent");
  assert.equal(fmtCost(0.084), "$0.08");
  assert.equal(fmtCost(null), "-");
  assert.equal(fmtCents(0.0038), "$0.00", "amounts a human set keep two decimals");
  assert.equal(costCell({ costUsd: 0, costStatus: "reported" }), "$0.00");
  assert.equal(costCell({ costUsd: 0.0038, costStatus: "estimated" }), "~<$0.01");
  assert.equal(costCell({ costUsd: 0.0099, costStatus: "reported" }), "<$0.01");
  assert.equal(costCell({ costUsd: 0.01, costStatus: "reported" }), "$0.01");
  assert.equal(costCell({ costUsd: 0.084, costStatus: "reported" }), "$0.08");
  assert.equal(costCell({ costUsd: null, costStatus: null }), "-");
  assert.equal(costCell({ costUsd: null, costStatus: "unpriced" }), "?");
  assert.equal(fmtPercent(0.8), "80%");
  assert.equal(fmtPercent(null), "-");

  assert.equal(oneLine("a\n   b "), "a b");
  assert.equal(oneLine("x".repeat(10), 8), "xxxxx...");
  assert.equal(badge("timed_out", plain()), "✗ timed out");
  assert.equal(badge("completed", plain(), true), "! needs review");
  assert.equal(badge("cancelled", plain()), "– cancelled");
  assert.equal(shortModel("claude-sonnet-4-5-20250929"), "sonnet");
  assert.equal(shortModel("custom-model"), "custom-model");
  assert.equal(tildePath("/home/me/src/app", "/home/me"), "~/src/app");
  assert.equal(tildePath("/srv/app", "/home/me"), "/srv/app");
  const cutPath = cutMiddle("/home/me/.config/Claude/claude_desktop_config.json", 30);
  assert.equal(cutPath.length, 30);
  assert.match(cutPath, /^\/home\/me\/.+\/…\/.+config\.json$/);
});

test("paint: plain text without colour, the DS-33 SGR codes with it; never red 31 or bright black 90", () => {
  const expected = {
    ok: "\x1b[32mx\x1b[39m",
    warn: "\x1b[33mx\x1b[39m",
    bad: "\x1b[91m\x1b[1mx\x1b[22m\x1b[39m",
    run: "\x1b[36mx\x1b[39m",
    accent: "\x1b[35mx\x1b[39m",
    muted: "\x1b[2mx\x1b[22m",
    heading: "\x1b[1mx\x1b[22m",
    strong: "\x1b[1mx\x1b[22m",
  };
  assert.deepEqual([...ROLES].sort(), Object.keys(expected).sort());
  for (const role of ROLES) {
    assert.equal(paint(role, "x", { color: false }), "x");
    assert.equal(paint(role, "x", { color: true }), expected[role], role);
    const painted = paint(role, "x", { color: true });
    assert.ok(!painted.includes("\x1b[31m") && !painted.includes("\x1b[90m"), role);
  }
  const color = { color: true, width: 100 };
  assert.equal(badge("failed", color), "\x1b[91m\x1b[1m✗ failed\x1b[22m\x1b[39m", "failed paints glyph and word");
  assert.equal(badge("completed", color), "\x1b[32m✓\x1b[39m completed", "the other words stay default fg");
  assert.equal(badge("running", color), "\x1b[36m●\x1b[39m running");
  assert.equal(badge("completed", color, true), "\x1b[33m!\x1b[39m \x1b[1mneeds review\x1b[22m");
});
