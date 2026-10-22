/** Cron parser and next-fire computation, including London DST transitions. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, localParts, nextFire, parseCron } from "@duskfleet/core";

const LONDON = "Europe/London";

test("parses the Factory expressions and describes them", () => {
  assert.equal(describeCron(parseCron("0 8-20 * * 1-5")), "weekdays 08–20 at :00");
  assert.equal(describeCron(parseCron("30 8-20 * * 1-5")), "weekdays 08–20 at :30");
  assert.equal(describeCron(parseCron("45 7 * * 1-5")), "weekdays at 07:45");
  assert.equal(describeCron(parseCron("*/15 * * * *")), "*/15 * * * *");
  assert.deepEqual([...parseCron("0 9 * * mon-fri").dayOfWeek], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 1 jan,jul * ").month], [1, 7]);
  assert.deepEqual([...parseCron("0 0 * * 7").dayOfWeek], [0], "7 means Sunday");
});

test("rejects malformed expressions and unknown zones", () => {
  assert.throws(() => parseCron("0 8 * *"), /5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /out of range/);
  assert.throws(() => parseCron("0 20-8 * * *"), /reversed/);
  assert.throws(() => parseCron("0 * * * xyz"), /unknown name/);
  assert.throws(() => nextFire(parseCron("* * * * *"), new Date(), "Mars/Olympus"), /unknown time zone/);
});

test("next fire respects weekdays and hours in London time", () => {
  const spec = parseCron("30 8-20 * * 1-5");
  // Friday 2026-10-09 20:31 London (BST, UTC+1) → next is Monday 2026-10-12 08:30 BST = 07:30Z
  const after = new Date("2026-10-09T19:31:00Z");
  const next = nextFire(spec, after, LONDON);
  assert.equal(next.toISOString(), "2026-10-12T07:30:00.000Z");
  const p = localParts(next, LONDON);
  assert.deepEqual([p.weekday, p.hour, p.minute], [1, 8, 30]);
});

test("next fire is strictly after the reference minute", () => {
  const spec = parseCron("0 8-20 * * 1-5");
  const at = new Date("2026-10-07T09:00:00Z"); // Wednesday 10:00 BST, on the hour
  assert.equal(nextFire(spec, at, LONDON).toISOString(), "2026-10-07T10:00:00.000Z");
});

test("DST: clocks go back on 2026-10-25, a 09:00 London job fires once at 09:00 GMT", () => {
  const spec = parseCron("0 9 * * *");
  // Saturday 24 Oct 2026 10:00 BST
  const sat = nextFire(spec, new Date("2026-10-24T09:30:00Z"), LONDON);
  assert.equal(sat.toISOString(), "2026-10-25T09:00:00.000Z", "Sunday 09:00 GMT (UTC+0 after the change)");
  const mon = nextFire(spec, sat, LONDON);
  assert.equal(mon.toISOString(), "2026-10-26T09:00:00.000Z");
});

test("DST: clocks go forward on 2026-03-29, a 01:30 London job that does not exist that night is skipped to the next day", () => {
  const spec = parseCron("30 1 * * *");
  const next = nextFire(spec, new Date("2026-03-28T02:00:00Z"), LONDON); // Sat 02:00 GMT
  assert.equal(next.toISOString(), "2026-03-30T00:30:00.000Z", "Monday 01:30 BST");
});

test("hourly jobs in a zone far from UTC", () => {
  const spec = parseCron("0 9-17 * * 1-5");
  const next = nextFire(spec, new Date("2026-10-09T23:30:00Z"), "Asia/Tokyo"); // Sat 08:30 JST
  assert.equal(next.toISOString(), "2026-10-12T00:00:00.000Z", "Monday 09:00 JST");
});
