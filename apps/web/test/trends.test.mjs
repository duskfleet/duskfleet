import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bucketLabel,
  cleanRate,
  countAxis,
  granularityText,
  percentAxis,
  spreadLabels,
  worseningAgent,
  xTickIndexes,
} from "../lib/trends.ts";

test("cleanRate is a gap, not a zero, when nothing finished", () => {
  assert.equal(cleanRate({ finished: 0, clean: 0, needsReview: 0, cancelled: 0 }), null);
  assert.equal(cleanRate({ finished: 4, clean: 3, needsReview: 1, cancelled: 0 }), 75);
});

test("worseningAgent picks the largest drop over at least 3 points", () => {
  const series = [
    { agentId: "steady", rates: [90, 91, 90, 92] },
    { agentId: "falls", rates: [92, null, 80, 62] },
    { agentId: "short", rates: [100, null, null, 0] },
  ];
  assert.deepEqual(worseningAgent(series), { agentId: "falls", drop: 30, buckets: 3 });
  assert.equal(worseningAgent([{ agentId: "steady", rates: [90, 88, 87] }]), null);
});

test("percentAxis starts at 50 at most and steps by 10 or 25", () => {
  assert.deepEqual(percentAxis([62, 98]), { min: 50, max: 100, ticks: [50, 60, 70, 80, 90, 100] });
  assert.deepEqual(percentAxis([95]).ticks, [50, 60, 70, 80, 90, 100]);
  assert.deepEqual(percentAxis([20]).ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(percentAxis([0]).ticks, [0, 25, 50, 75, 100]);
});

test("countAxis uses whole steps up to a round maximum", () => {
  assert.deepEqual(countAxis(26), { max: 30, ticks: [0, 10, 20, 30] });
  assert.deepEqual(countAxis(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(countAxis(5).ticks, [0, 2, 4, 6]);
});

test("xTickIndexes ends on the last bucket", () => {
  assert.deepEqual(xTickIndexes(13), [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(xTickIndexes(30), [4, 9, 14, 19, 24, 29]);
  assert.deepEqual(xTickIndexes(1), [0]);
});

test("spreadLabels keeps labels apart and inside the plot", () => {
  const out = spreadLabels(
    [
      { id: "a", top: 10 },
      { id: "b", top: 12 },
      { id: "c", top: 229 },
      { id: "d", top: 230 },
    ],
    17,
    230,
  );
  assert.deepEqual(
    out.map((o) => [o.id, o.top]),
    [
      ["a", 10],
      ["b", 27],
      ["c", 213],
      ["d", 230],
    ],
  );
});

test("labels are UTC", () => {
  assert.equal(bucketLabel("2026-07-20", "week"), "20 Jul");
  assert.equal(bucketLabel("2026-10-01", "month"), "Oct");
  assert.equal(granularityText("week", 13, new Date("2026-10-12T21:08:00Z")), "weekly · 13 weeks to Mon 12 Oct");
});
