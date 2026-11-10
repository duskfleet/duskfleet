import type { Metadata } from "next";
import { AttentionEmpty, AttentionSections, AttentionSeen, AttentionSummary } from "@/components/Attention";
import { AutoRefresh } from "@/components/AutoRefresh";
import { MarkSeenButton, SeenToast } from "@/components/SeenControls";
import { type AttentionItem, dismissableKeys } from "@/lib/attention";
import { attentionView } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Alerts · Duskfleet" };

/**
 * DS-28: everything that needs a human, grouped by kind in a fixed order. DS-32 (issue #430): an item
 * can be marked seen; it moves to the Seen group and stops counting in the badge until a new event.
 */
export default function AttentionPage() {
  const now = Date.now();
  const view = attentionView(now);
  const unseen = view.sections.flatMap((s) => s.items as AttentionItem[]);
  const allKeys = dismissableKeys(unseen);
  return (
    <main className="attention">
      <AutoRefresh intervalMs={3000} />
      <div className="page-head att-head">
        <div className="att-title-row">
          <h1>
            Alerts{" "}
            <span className="count">
              {unseen.length} unseen · {view.total === 1 ? "1 item" : `${view.total} items`}
            </span>
          </h1>
          {allKeys.length > 0 && <MarkSeenButton keys={allKeys} label="Mark all seen" />}
        </div>
        <p className="att-note">
          {view.total === 0
            ? "Everything that needs a human shows up here. The Alerts tab carries no badge at 0."
            : "Grouped by kind, in a fixed order. Mark an item seen once you have read it: it stops counting in the nav badge and comes back by itself when something new happens. Login and quota errors cannot be marked seen; they leave when fixed."}
        </p>
      </div>
      <AttentionSummary sections={view.sections} seen={view.seen.length} />
      {unseen.length === 0 ? (
        <AttentionEmpty now={now} total={view.total} />
      ) : (
        <AttentionSections sections={view.sections} now={now} />
      )}
      <AttentionSeen items={view.seen} now={now} open={unseen.length > 0} />
      <SeenToast />
    </main>
  );
}
