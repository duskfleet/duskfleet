/**
 * SQLite persistence of the dashboard's "seen" marks on Alerts items (migration 29, issue #430).
 * One row per item key (`kind` + subject id + latest event id): an item is seen when a row exists
 * for its current key. A new event changes the key, so the item comes back by itself; the old row
 * stays inert and tells the dashboard when it was last seen ("New since seen hh:mm").
 */

import type { DatabaseSync } from "node:sqlite";

export interface AttentionAck {
  itemKey: string;
  kind: string;
  subjectId: string;
  eventId: string;
  seenAt: string;
}

interface AckRow {
  item_key: string;
  kind: string;
  subject_id: string;
  event_id: string;
  seen_at: string;
}

const toAck = (r: AckRow): AttentionAck => ({
  itemKey: r.item_key,
  kind: r.kind,
  subjectId: r.subject_id,
  eventId: r.event_id,
  seenAt: r.seen_at,
});

export class AttentionAckRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Every ack, newest first. */
  list(): AttentionAck[] {
    return (
      this.db
        .prepare("SELECT item_key, kind, subject_id, event_id, seen_at FROM attention_acks ORDER BY seen_at DESC")
        .all() as unknown as AckRow[]
    ).map(toAck);
  }

  /** Inserts the acks that do not exist yet; returns the keys actually inserted (what an Undo removes). */
  insert(acks: Array<Omit<AttentionAck, "seenAt">>, seenAt = new Date().toISOString()): string[] {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO attention_acks (item_key, kind, subject_id, event_id, seen_at) VALUES (?, ?, ?, ?, ?)",
    );
    const inserted: string[] = [];
    this.db.exec("BEGIN");
    try {
      for (const a of acks) {
        if (Number(stmt.run(a.itemKey, a.kind, a.subjectId, a.eventId, seenAt).changes) > 0) inserted.push(a.itemKey);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return inserted;
  }

  /** Deletes exactly these keys; returns how many rows went. */
  delete(itemKeys: string[]): number {
    const stmt = this.db.prepare("DELETE FROM attention_acks WHERE item_key = ?");
    let n = 0;
    for (const k of itemKeys) n += Number(stmt.run(k).changes);
    return n;
  }

  /** Deletes every ack of one kind + subject, older events included (un-see: no "new since seen" after it). */
  deleteSubject(kind: string, subjectId: string): number {
    return Number(
      this.db.prepare("DELETE FROM attention_acks WHERE kind = ? AND subject_id = ?").run(kind, subjectId).changes,
    );
  }

  /** Drops acks seen before `before` (ISO) whose key is not in `keep`: stale rows match no item. */
  prune(before: string, keep: string[] = []): number {
    const keepSet = new Set(keep);
    const stale = (
      this.db.prepare("SELECT item_key FROM attention_acks WHERE seen_at < ?").all(before) as Array<{
        item_key: string;
      }>
    ).filter((r) => !keepSet.has(r.item_key));
    return this.delete(stale.map((r) => r.item_key));
  }
}
