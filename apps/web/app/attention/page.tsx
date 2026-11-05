import type { Metadata } from "next";
import { AttentionEmpty, AttentionSections, AttentionSummary } from "@/components/Attention";
import { AutoRefresh } from "@/components/AutoRefresh";
import { attention } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Attention · Duskfleet" };

/** DS-28: everything that needs a human, grouped by kind in a fixed order; a pure view, no dismiss. */
export default function AttentionPage() {
  const now = Date.now();
  const sections = attention(now);
  const count = sections.reduce((n, s) => n + s.items.length, 0);
  return (
    <main className="attention">
      <AutoRefresh intervalMs={3000} />
      <div className="page-head att-head">
        <h1>
          Attention <span className="count">{count === 1 ? "1 item" : `${count} items`}</span>
        </h1>
        <p className="att-note">
          {count === 0
            ? "Everything that needs a human shows up here. The Attention tab carries no badge at 0."
            : "Grouped by kind, in a fixed order: login, failed runs, review, schedules, budgets, busy. Empty sections are hidden; an item leaves when its cause is fixed or after 48 hours."}
        </p>
      </div>
      <AttentionSummary sections={sections} />
      {count === 0 ? <AttentionEmpty now={now} /> : <AttentionSections sections={sections} now={now} />}
    </main>
  );
}
