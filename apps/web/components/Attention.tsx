import Link from "next/link";
import type { ReactNode } from "react";
import { MarkSeenButton, SeenGroup, SeenToggle } from "@/components/SeenControls";
import {
  type AttentionItem,
  type AttentionSection,
  ackKey,
  type BudgetItem,
  type BusyItem,
  dismissableKeys,
  type LoginItem,
  type RunItem,
  type ScheduleItem,
  type SectionKind,
  summaryChips,
  type Tone,
} from "@/lib/attention";
import { fmtClock, shortModel } from "@/lib/format";

/**
 * DS-28 /attention (Direction B, sections by kind): one table per kind at 1280, stacked cards at
 * 390 (CSS only, same markup). "How to fix" is a <details> whose open state shows the fix row
 * under its row (CSS :has), so the page URL never changes and no client JS is needed.
 * DS-32 (issue #430): a seen toggle per row, "Mark section seen" per heading, and the seen items in
 * a Seen group at the bottom (components/SeenControls.tsx holds the client parts).
 */

/** The heading note of a section holding items that leave only when fixed. */
export const CANNOT_SEE_NOTE = "Cannot be marked seen: leaves when fixed";

/** A status chip of the page: outline and ink of its tone on the tone's tint. */
export function KindChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`att-chip ${tone}`}>{children}</span>;
}

/** The chips under the title, one per section with unseen items ("1 login error", ...), then "n seen". */
export function AttentionSummary({ sections, seen = 0 }: { sections: AttentionSection[]; seen?: number }) {
  const chips = summaryChips(sections, seen);
  if (chips.length === 0) return null;
  return (
    <div className="att-summary">
      {chips.map((c) => (
        <KindChip key={c.kind} tone={c.tone}>
          {c.label}
        </KindChip>
      ))}
    </div>
  );
}

const minutes = (ms: number | null) => (ms === null ? "–" : `${Math.max(1, Math.round(ms / 60_000))} min`);
const usd = (n: number) => `$${n.toFixed(2)}`;

const COLUMNS: Record<SectionKind, string[]> = {
  login: ["Error", "What happened", "Runs", "Since"],
  failed: ["Status", "Run", "Model", "Duration", "When"],
  review: ["Status", "Run", "Model", "Duration", "When"],
  schedules: ["State", "Schedule", "Paused", "Next fire if resumed"],
  budgets: ["Level", "Budget", "Spent"],
  busy: ["Streak", "Schedule", "Last skip"],
};

/** Columns that hold numbers or times: right-aligned, tabular. */
const NUMERIC = new Set(["Runs", "Since", "Duration", "When", "Paused", "Next fire if resumed", "Spent", "Last skip"]);

/** "New since seen 20:40": an unseen item an older event of which was marked seen. */
function NewSinceSeen({ at, now }: { at: string; now: number }) {
  return (
    <span className="att-new">
      <span className="att-new-dot" aria-hidden="true" />
      New since seen<span className="att-new-time"> {fmtClock(at, now)}</span>
    </span>
  );
}

function Main({
  title,
  detail,
  narrow,
  newSince,
  now,
}: {
  title: string;
  detail: string;
  narrow?: string;
  newSince?: string;
  now: number;
}) {
  return (
    <td className="c-main">
      <div className="att-title">
        {title}
        {newSince && <NewSinceSeen at={newSince} now={now} />}
      </div>
      <div className="att-detail">
        {detail}
        {narrow && <span className="att-narrow"> {narrow}</span>}
      </div>
    </td>
  );
}

function Act({ href, children }: { href: string; children: ReactNode }) {
  return (
    <td className="c-act">
      <Link href={href} className="att-link">
        {children}
      </Link>
    </td>
  );
}

/** The seen toggle cell; empty for the kinds that cannot be marked seen (never a disabled button). */
function SeenCell({ item }: { item: AttentionItem }) {
  return (
    <td className="c-seen">
      {item.dismissable && <SeenToggle itemKey={ackKey(item)} label={item.label} pressed={item.seenAt !== undefined} />}
    </td>
  );
}

function LoginRows({ item, now }: { item: LoginItem; now: number }) {
  const fixId = `fix-${item.code}`;
  return (
    <>
      <tr className="att-row tint-bad">
        <td className="c-badge">
          <KindChip tone={item.tone}>{item.badge}</KindChip>
        </td>
        <Main title={item.title} detail={item.detail} now={now} />
        <td className="c-meta num">{item.runs === 1 ? "1 run" : `${item.runs} runs`}</td>
        <td className="c-when num">{fmtClock(item.at, now)}</td>
        <td className="c-act">
          <details className="att-fix">
            <summary aria-controls={fixId}>How to fix →</summary>
          </details>
        </td>
        <SeenCell item={item} />
      </tr>
      <tr className="att-fix-row" id={fixId}>
        <td colSpan={6}>
          <div className="att-fix-box">
            <span className="att-fix-label">How to fix</span> {item.fix}
          </div>
        </td>
      </tr>
    </>
  );
}

function RunRowItem({ item, now }: { item: RunItem; now: number }) {
  return (
    <tr className="att-row">
      <td className="c-badge">
        <KindChip tone={item.tone}>{item.badge}</KindChip>
      </td>
      <Main title={`${item.agentId} · ${item.project}`} detail={item.detail} newSince={item.newSinceSeen} now={now} />
      <td className="c-meta mono">{item.model ? shortModel(item.model) : "–"}</td>
      <td className="c-meta num mono">{minutes(item.durationMs)}</td>
      <td className="c-when num">{fmtClock(item.at, now)}</td>
      <Act href={`/runs/${item.runId}`}>Open run →</Act>
      <SeenCell item={item} />
    </tr>
  );
}

function ScheduleRow({ item, now }: { item: ScheduleItem; now: number }) {
  const next = item.nextAt ? fmtClock(item.nextAt, now) : "–";
  return (
    <tr className="att-row">
      <td className="c-badge">
        <KindChip tone={item.tone}>{item.badge}</KindChip>
      </td>
      <Main
        title={`${item.name} · ${item.agentId}`}
        detail={item.detail}
        narrow={`Next fire if resumed: ${next}`}
        newSince={item.newSinceSeen}
        now={now}
      />
      <td className="c-when num">{fmtClock(item.at, now)}</td>
      <td className="c-meta num">{next}</td>
      <Act href={`/schedules#${item.scheduleId}`}>Open schedule →</Act>
      <SeenCell item={item} />
    </tr>
  );
}

function BudgetRow({ item, now }: { item: BudgetItem; now: number }) {
  return (
    <tr className="att-row">
      <td className="c-badge">
        <KindChip tone={item.tone}>{item.badge}</KindChip>
      </td>
      <Main title={item.title} detail={item.detail} newSince={item.newSinceSeen} now={now} />
      <td className="c-meta num mono">
        {usd(item.countedUsd)} / {usd(item.amountUsd)}
      </td>
      <Act href="/costs">Open Costs →</Act>
      <SeenCell item={item} />
    </tr>
  );
}

function BusyRow({ item, now }: { item: BusyItem; now: number }) {
  return (
    <tr className="att-row">
      <td className="c-badge">
        <KindChip tone={item.tone}>{item.badge}</KindChip>
      </td>
      <Main title={`${item.name} · ${item.agentId}`} detail={item.detail} newSince={item.newSinceSeen} now={now} />
      <td className="c-when num">{fmtClock(item.at, now)}</td>
      <Act href={`/schedules#${item.scheduleId}`}>Open schedule →</Act>
      <SeenCell item={item} />
    </tr>
  );
}

function Row({ item, now }: { item: AttentionItem; now: number }) {
  switch (item.kind) {
    case "login":
      return <LoginRows item={item} now={now} />;
    case "failed":
    case "review":
      return <RunRowItem item={item} now={now} />;
    case "schedules":
      return <ScheduleRow item={item} now={now} />;
    case "budgets":
      return <BudgetRow item={item} now={now} />;
    case "busy":
      return <BusyRow item={item} now={now} />;
  }
}

/** The unseen items' sections in their fixed order, one table each, with "Mark section seen". */
export function AttentionSections({ sections, now }: { sections: AttentionSection[]; now: number }) {
  return (
    <>
      {sections.map((s) => {
        const items = s.items as AttentionItem[];
        const keys = dismissableKeys(items);
        return (
          <section key={s.kind} className={`att-section att-${s.kind}`} aria-labelledby={`att-${s.kind}`}>
            <div className="att-section-head">
              <h2 id={`att-${s.kind}`} className="att-h2">
                {s.title} <span className="count">{items.length}</span>
                {items.some((i) => !i.dismissable) && <span className="att-head-note">{CANNOT_SEE_NOTE}</span>}
              </h2>
              {keys.length > 0 && <MarkSeenButton keys={keys} label="Mark section seen" short="Mark seen" />}
            </div>
            <table className="att-table">
              <thead>
                <tr>
                  {COLUMNS[s.kind].map((c, i) => (
                    <th
                      key={c}
                      className={i === 0 ? "c-badge" : i === 1 ? "c-main" : NUMERIC.has(c) ? "num" : undefined}
                      scope="col"
                    >
                      {c}
                    </th>
                  ))}
                  <th className="c-act" scope="col">
                    <span className="sr-only">Action</span>
                  </th>
                  <th className="c-seen" scope="col">
                    <span className="sr-only">Seen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <Row key={item.key} item={item} now={now} />
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </>
  );
}

/** Title, where the row leads and its link text, for a row of the Seen group. */
function seenRowParts(item: AttentionItem): { title: string; href: string | null; act: string } {
  switch (item.kind) {
    case "login":
      return { title: item.title, href: null, act: "" };
    case "failed":
    case "review":
      return { title: `${item.agentId} · ${item.project}`, href: `/runs/${item.runId}`, act: "Open run →" };
    case "schedules":
    case "busy":
      return { title: `${item.name} · ${item.agentId}`, href: `/schedules#${item.scheduleId}`, act: "Open schedule →" };
    case "budgets":
      return { title: item.title, href: "/costs", act: "Open Costs →" };
  }
}

/** "seen 21:10", "seen just now" (under a minute). */
export function seenWhen(seenAt: string, now: number): string {
  return now - Date.parse(seenAt) < 60_000 ? "seen just now" : `seen ${fmtClock(seenAt, now)}`;
}

/** The Seen group: muted rows, each with the pressed toggle that un-sees it in place. */
export function AttentionSeen({ items, now, open }: { items: AttentionItem[]; now: number; open: boolean }) {
  if (items.length === 0) return null;
  return (
    // Keyed on `open`: marking the last unseen item collapses the group, as the all-seen frame shows.
    <SeenGroup key={open ? "open" : "collapsed"} count={items.length} defaultOpen={open}>
      <table className="att-table att-seen-table">
        <thead>
          <tr>
            <th className="c-badge" scope="col">
              Kind
            </th>
            <th className="c-main" scope="col">
              Item
            </th>
            <th scope="col">Seen</th>
            <th className="c-act" scope="col">
              <span className="sr-only">Action</span>
            </th>
            <th className="c-seen" scope="col">
              <span className="sr-only">Unsee</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const p = seenRowParts(item);
            return (
              <tr key={item.key} className="att-row att-seen-row">
                <td className="c-badge">
                  <KindChip tone={item.tone}>{item.badge}</KindChip>
                </td>
                <td className="c-main">
                  <div className="att-title">{p.title}</div>
                  <div className="att-detail">{item.detail}</div>
                </td>
                <td className="c-when">{item.seenAt ? seenWhen(item.seenAt, now) : ""}</td>
                {p.href ? <Act href={p.href}>{p.act}</Act> : <td className="c-act" />}
                <SeenCell item={item} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </SeenGroup>
  );
}

/**
 * No unseen item: a calm card instead of the tables, and no badge on the tab. With seen items
 * ("All M items are seen") it says what brings one back; with none at all, "Nothing needs you".
 */
export function AttentionEmpty({ now, total = 0 }: { now: number; total?: number }) {
  if (total > 0) {
    return (
      <div className="card att-empty">
        <p className="att-empty-title">{total === 1 ? "The 1 item is seen" : `All ${total} items are seen`}</p>
        <p className="att-empty-text">
          Nothing new since you last looked. A seen item comes back here by itself when something new happens: another
          failed run of the same agent, a new firing outcome, the next budget threshold.
        </p>
      </div>
    );
  }
  return (
    <div className="card att-empty">
      <p className="att-empty-title">
        <span className="att-ok-dot" aria-hidden="true" />
        Nothing needs you
      </p>
      <p className="att-empty-text">
        No failed or review runs, no paused schedules, budgets under their warning, Claude logged in. Checked at{" "}
        {fmtClock(new Date(now).toISOString(), now)}, refreshed live.
      </p>
      <Link href="/" className="att-link">
        Recent runs →
      </Link>
    </div>
  );
}
