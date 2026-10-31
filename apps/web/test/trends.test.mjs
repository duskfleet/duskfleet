import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentRows,
  bucketLabel,
  cleanRate,
  countAxis,
  defaultSelection,
  deltaText,
  granularityText,
  mergeSeries,
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

test("percentAxis: 25-point steps from 0 under 40, else 10-point steps", () => {
  assert.deepEqual(percentAxis([39, 90]).ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(percentAxis([45]).ticks, [40, 50, 60, 70, 80, 90, 100]);
});

test("spreadLabels clamps every label to the plot box", () => {
  const out = spreadLabels(
    Array.from({ length: 6 }, (_, i) => ({ id: String(i), top: 230 })),
    15,
    232,
  );
  assert.deepEqual(
    out.map((o) => o.top),
    [157, 172, 187, 202, 217, 232],
  );
  assert.deepEqual(
    spreadLabels([{ id: "a", top: -4 }], 15, 232).map((o) => o.top),
    [0],
  );
});

const counts = (...rates) =>
  rates.map((r) => (r === null ? { finished: 0, clean: 0, needsReview: 0, cancelled: 0 } : { finished: 10, clean: r / 10, needsReview: 10 - r / 10, cancelled: 0 }));

test("agentRows ranks the lowest current clean rate first with the change over the period", () => {
  const rows = agentRows([
    { agentId: "b", counts: counts(90, 80, 60) },
    { agentId: "a", counts: counts(null, 20, 30) },
    { agentId: "c", counts: counts(null, null, null) },
    { agentId: "d", counts: counts(null, null, 60) },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.agentId, r.rate, r.delta, r.runs]),
    [
      ["a", 30, 10, 20],
      ["b", 60, -30, 30],
      ["d", 60, null, 10],
      ["c", null, null, 0],
    ],
  );
  assert.deepEqual(defaultSelection(rows, "b"), ["b", "a", "d"]);
  assert.deepEqual(defaultSelection(rows, null), ["a", "b", "d"]);
  assert.equal(deltaText(-8), "↓8");
  assert.equal(deltaText(4), "↑4");
  assert.equal(deltaText(0), "·0");
  assert.equal(deltaText(null), "–");
});

test("mergeSeries sums the agents of a multi-value ?agent=", () => {
  const part = (agentId, clean, reason, firstRunAt) => ({
    overall: [{ finished: 2, clean, needsReview: 2 - clean, cancelled: 0 }],
    byAgent: [{ agentId, counts: [{ finished: 2, clean, needsReview: 2 - clean, cancelled: 0 }] }],
    totals: { finished: 2, clean, needsReview: 2 - clean, cancelled: 0 },
    reasons: [{ reason, count: 2 - clean }],
    firstRunAt,
  });
  const m = mergeSeries([part("a", 1, "denial", "2026-10-02"), part("b", 0, "denial", "2026-10-01")]);
  assert.deepEqual(m.overall, [{ finished: 4, clean: 1, needsReview: 3, cancelled: 0 }]);
  assert.deepEqual(m.totals, { finished: 4, clean: 1, needsReview: 3, cancelled: 0 });
  assert.deepEqual(m.reasons, [{ reason: "denial", count: 3 }]);
  assert.deepEqual(
    m.byAgent.map((a) => a.agentId),
    ["a", "b"],
  );
  assert.equal(m.firstRunAt, "2026-10-01");
  assert.equal(mergeSeries([]), undefined);
});

test("labels are UTC", () => {
  assert.equal(bucketLabel("2026-07-20", "week"), "20 Jul");
  assert.equal(bucketLabel("2026-10-01", "month"), "Oct");
  assert.equal(granularityText("week", 13, new Date("2026-10-12T21:08:00Z")), "weekly · 13 weeks to Mon 12 Oct");
});
