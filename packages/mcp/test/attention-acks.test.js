/**
 * The dashboard's "seen" marks on Alerts items (migration 29, issue #430): insert reports exactly
 * the rows it added (what an Undo deletes), un-see drops a subject's acks, prune keeps current keys.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.js";
import { AttentionAckRepository, openDatabase } from "@duskfleet/core";

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "df-acks-"));
  const db = openDatabase(dir);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new AttentionAckRepository(db);
}

const ack = (kind, subjectId, eventId) => ({ itemKey: `${kind}:${subjectId}:${eventId}`, kind, subjectId, eventId });

test("migration 29 creates attention_acks; insert returns only the new keys", (t) => {
  const acks = repo(t);
  assert.deepEqual(acks.list(), []);
  const first = acks.insert([ack("failed", "dev", "r1"), ack("busy", "s1", "9")], "2026-11-10T10:00:00.000Z");
  assert.deepEqual(first, ["failed:dev:r1", "busy:s1:9"]);
  // already seen: not inserted again, so an Undo of this call deletes nothing it did not add
  const again = acks.insert([ack("failed", "dev", "r1"), ack("review", "dev", "r2")], "2026-11-10T11:00:00.000Z");
  assert.deepEqual(again, ["review:dev:r2"]);
  assert.deepEqual(
    acks.list().map((a) => [a.itemKey, a.kind, a.subjectId, a.eventId, a.seenAt]),
    [
      ["review:dev:r2", "review", "dev", "r2", "2026-11-10T11:00:00.000Z"],
      ["failed:dev:r1", "failed", "dev", "r1", "2026-11-10T10:00:00.000Z"],
      ["busy:s1:9", "busy", "s1", "9", "2026-11-10T10:00:00.000Z"],
    ],
  );
  assert.equal(acks.delete(again), 1);
  assert.equal(acks.list().length, 2);
});

test("deleteSubject drops every event of one kind + subject; prune keeps current keys", (t) => {
  const acks = repo(t);
  acks.insert([ack("failed", "dev", "r1")], "2026-11-01T00:00:00.000Z");
  acks.insert([ack("failed", "dev", "r2"), ack("budgets", "b1", "2026-11:warn")], "2026-11-02T00:00:00.000Z");
  acks.insert([ack("busy", "s1", "9")], "2026-11-09T00:00:00.000Z");
  assert.equal(acks.deleteSubject("failed", "dev"), 2);
  assert.equal(acks.prune("2026-11-08T00:00:00.000Z", ["budgets:b1:2026-11:warn"]), 0);
  acks.insert([ack("schedules", "s2", "5")], "2026-11-03T00:00:00.000Z");
  assert.equal(acks.prune("2026-11-08T00:00:00.000Z", ["budgets:b1:2026-11:warn"]), 1);
  assert.deepEqual(
    acks.list().map((a) => a.itemKey),
    ["busy:s1:9", "budgets:b1:2026-11:warn"],
  );
});
