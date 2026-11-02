// outcomeSeries (the dashboard's /trends) on a seeded DB: UTC buckets, ISO-week and month edges.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDatabase, outcomeSeries, recentReviewReasons, trendBuckets } from "@duskfleet/core";

// Wednesday 14 Oct 2026, noon UTC: its ISO week starts on Monday 12 Oct.
const NOW = new Date("2026-10-14T12:00:00.000Z");

function seeded(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), "df-trends-"));
  const db = openDatabase(dir);
  const insert = db.prepare(
    `INSERT INTO runs (id, agent_id, project_path, prompt, status, created_at, permission_mode, command_json,
       review_reasons_json, kind)
     VALUES (?, ?, ?, 'x', ?, ?, 'dontAsk', '[]', ?, ?)`,
  );
  for (const r of rows) {
    insert.run(r.id, r.agent ?? "a", r.project ?? "/p", r.status, r.at, r.reasons ?? null, r.kind ?? "run");
  }
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("trendBuckets lists every bucket of the range, the last one holding now", () => {
  const day = trendBuckets("1m", NOW);
  assert.equal(day.bucket, "day");
  assert.equal(day.starts.length, 30);
  assert.equal(day.starts.at(-1), "2026-10-14");
  assert.equal(day.starts[0], "2026-09-15");
  assert.equal(day.end, "2026-10-15T00:00:00.000Z");

  const weeks = trendBuckets("3m", NOW);
  assert.equal(weeks.bucket, "week");
  assert.equal(weeks.starts.length, 13);
  assert.equal(weeks.starts.at(-1), "2026-10-12");
  assert.equal(weeks.starts[0], "2026-07-20");
  assert.equal(trendBuckets("6m", NOW).starts.length, 26);

  const months = trendBuckets("1y", NOW);
  assert.equal(months.bucket, "month");
  assert.deepEqual([months.starts[0], months.starts.at(-1)], ["2025-11-01", "2026-10-01"]);
  assert.equal(months.end, "2026-11-01T00:00:00.000Z");

  // An ISO week across the new year starts on the Monday of the old one.
  const newYear = trendBuckets("3m", new Date("2026-01-01T08:00:00.000Z"));
  assert.equal(newYear.starts.at(-1), "2025-12-29");
});

test("outcomeSeries buckets finished real runs by UTC week and splits them by outcome", () => {
  const { db, cleanup } = seeded([
    { id: "sun-late", status: "completed", at: "2026-10-11T23:59:59.999Z" },
    { id: "mon-midnight", status: "completed", at: "2026-10-12T00:00:00.000Z" },
    { id: "denied", status: "completed", at: "2026-10-13T10:00:00.000Z", reasons: '["permission_denied"]' },
    {
      id: "denied-empty",
      status: "completed",
      at: "2026-10-13T11:00:00.000Z",
      reasons: '["permission_denied","empty_run"]',
    },
    { id: "cancelled", status: "cancelled", at: "2026-10-13T12:00:00.000Z" },
    { id: "timed-out", agent: "b", status: "timed_out", at: "2026-10-01T09:00:00.000Z", reasons: '["timed_out"]' },
    { id: "running", status: "running", at: "2026-10-14T09:00:00.000Z" },
    { id: "gate", status: "completed", at: "2026-10-13T09:00:00.000Z", reasons: '["permission_denied"]', kind: "gate" },
    { id: "too-old", status: "completed", at: "2026-07-19T23:00:00.000Z" },
  ]);
  try {
    const s = outcomeSeries(db, { range: "3m", now: NOW });
    const last = s.overall.at(-1);
    assert.deepEqual(last, { finished: 4, clean: 1, needsReview: 2, cancelled: 1 });
    assert.deepEqual(s.overall.at(-2), { finished: 1, clean: 1, needsReview: 0, cancelled: 0 });
    // Week of 28 Sep holds b's timed-out run; empty weeks are zeros, not missing.
    assert.deepEqual(s.overall[s.starts.indexOf("2026-09-28")], {
      finished: 1,
      clean: 0,
      needsReview: 1,
      cancelled: 0,
    });
    assert.equal(s.overall.length, 13);
    assert.deepEqual(s.overall[0], { finished: 0, clean: 0, needsReview: 0, cancelled: 0 });
    assert.deepEqual(s.totals, { finished: 6, clean: 2, needsReview: 3, cancelled: 1 });
    assert.deepEqual(
      s.byAgent.map((a) => a.agentId),
      ["a", "b"],
    );
    assert.deepEqual(s.reasons, [
      { reason: "permission_denied", count: 2 },
      { reason: "empty_run", count: 1 },
      { reason: "timed_out", count: 1 },
    ]);
    // The first finished real run of the scope, outside the period too.
    assert.equal(s.firstRunAt, "2026-07-19T23:00:00.000Z");

    const onlyB = outcomeSeries(db, { range: "3m", now: NOW, agentId: "b" });
    assert.deepEqual(onlyB.totals, { finished: 1, clean: 0, needsReview: 1, cancelled: 0 });
    assert.equal(onlyB.firstRunAt, "2026-10-01T09:00:00.000Z");
    assert.equal(outcomeSeries(db, { range: "3m", now: NOW, projectPath: "/other" }).totals.finished, 0);
  } finally {
    cleanup();
  }
});

test("outcomeSeries puts the last instant of a month and the first of the next in two buckets", () => {
  const { db, cleanup } = seeded([
    { id: "sep-end", status: "completed", at: "2026-09-30T23:59:59.999Z" },
    { id: "oct-start", status: "failed", at: "2026-10-01T00:00:00.000Z", reasons: '["failed"]' },
  ]);
  try {
    const s = outcomeSeries(db, { range: "1y", now: NOW });
    assert.equal(s.starts.length, 12);
    assert.deepEqual(s.overall[s.starts.indexOf("2026-09-01")], {
      finished: 1,
      clean: 1,
      needsReview: 0,
      cancelled: 0,
    });
    assert.deepEqual(s.overall[s.starts.indexOf("2026-10-01")], {
      finished: 1,
      clean: 0,
      needsReview: 1,
      cancelled: 0,
    });
    const days = outcomeSeries(db, { range: "1m", now: NOW });
    assert.equal(days.overall[days.starts.indexOf("2026-09-30")].finished, 1);
    assert.equal(days.overall[days.starts.indexOf("2026-10-01")].finished, 1);
  } finally {
    cleanup();
  }
});

test("recentReviewReasons counts each reason once per run over the agent's last reviews", () => {
  const { db, cleanup } = seeded([
    { id: "r1", status: "completed", at: "2026-10-10T00:00:00.000Z", reasons: '["permission_denied"]' },
    { id: "r2", status: "completed", at: "2026-10-11T00:00:00.000Z", reasons: '["permission_denied","empty_run"]' },
    { id: "r3", status: "timed_out", at: "2026-10-12T00:00:00.000Z", reasons: '["timed_out"]' },
    { id: "clean", status: "completed", at: "2026-10-13T00:00:00.000Z" },
  ]);
  try {
    assert.deepEqual(recentReviewReasons(db, "a", 2), {
      reviews: 2,
      reasons: [
        { reason: "empty_run", count: 1 },
        { reason: "permission_denied", count: 1 },
        { reason: "timed_out", count: 1 },
      ],
    });
    assert.equal(recentReviewReasons(db, "a").reasons[0].reason, "permission_denied");
    assert.equal(recentReviewReasons(db, "a", 10, "/other").reviews, 0);
  } finally {
    cleanup();
  }
});
