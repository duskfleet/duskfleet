"use server";

/**
 * The Alerts "seen" marks (DS-32, issue #430): the only rows the dashboard writes for /attention,
 * in `attention_acks` (migration 29) through core's AttentionAckRepository. Marking checks every
 * key against the items as they are now (lib/attention.ts `acksFor`): login and quota errors and a
 * spent hard-stop budget are refused, they leave only when fixed. Runs, schedules and budgets are
 * never touched from here.
 */
import { revalidatePath } from "next/cache";
import { ATTENTION_WINDOW_MS, type AttentionItem, ackKey, acksFor } from "@/lib/attention";
import { attention, attentionAcks } from "@/lib/data";

export interface SeenResult {
  ok: boolean;
  message: string;
  /** The keys this call inserted: exactly what its Undo deletes. */
  inserted: string[];
}

function fail(err: unknown): SeenResult {
  return { ok: false, message: err instanceof Error ? err.message : String(err), inserted: [] };
}

/** Marks these items seen (one row, a section, or every item shown). */
export async function markSeenAction(keys: string[]): Promise<SeenResult> {
  try {
    const now = Date.now();
    const sections = attention(now);
    const { acks, refused } = acksFor(sections, keys);
    if (acks.length === 0) {
      return {
        ok: false,
        message: refused.length
          ? "Not marked: these items cannot be marked seen, or they changed meanwhile."
          : "Nothing to mark.",
        inserted: [],
      };
    }
    const repo = attentionAcks();
    const inserted = repo.insert(acks);
    // Stale rows (the cause is fixed, or past the 48 h window) match no item: drop them as we go.
    const current = sections.flatMap((s) => (s.items as AttentionItem[]).map(ackKey));
    repo.prune(new Date(now - ATTENTION_WINDOW_MS).toISOString(), current);
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: refused.length ? `${refused.length} could not be marked seen.` : "",
      inserted,
    };
  } catch (err) {
    return fail(err);
  }
}

/** Undo of a mark: deletes exactly the keys that mark inserted. */
export async function undoSeenAction(keys: string[]): Promise<SeenResult> {
  try {
    attentionAcks().delete(keys);
    revalidatePath("/", "layout");
    return { ok: true, message: "", inserted: [] };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Un-sees an item of the Seen group: deletes the ack of its current key and the older acks of the
 * same kind + subject, so the row returns as plain unseen, without a "New since seen" pill.
 */
export async function unseeAction(key: string): Promise<SeenResult> {
  try {
    const acks = attentionAcks();
    const current = acks.list().find((a) => a.itemKey === key);
    if (!current) return { ok: true, message: "", inserted: [] };
    acks.deleteSubject(current.kind, current.subjectId);
    revalidatePath("/", "layout");
    return { ok: true, message: "", inserted: [] };
  } catch (err) {
    return fail(err);
  }
}
