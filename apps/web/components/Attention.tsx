import Link from "next/link";
import type { ReactNode } from "react";
import {
  type AttentionItem,
  type AttentionSection,
  type BudgetItem,
  type BusyItem,
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
 */

/** A status chip of the page: outline and ink of its tone on the tone's tint. */
export function KindChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`att-chip ${tone}`}>{children}</span>;
}

/** The chips under the title, one per non-empty section: "1 login error", "6 failed runs", ... */
export function AttentionSummary({ sections }: { sections: AttentionSection[] }) {
  if (sections.length === 0) return null;
  return (
    <div className="att-summary">
      {summaryChips(sections).map((c) => (
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

function Main({ title, detail, narrow }: { title: string; detail: string; narrow?: string }) {
  return (
    <td className="c-main">
      <div className="att-title">{title}</div>
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

function LoginRows({ item, now }: { item: LoginItem; now: number }) {
  const fixId = `fix-${item.code}`;
  return (
    <>
      <tr className="att-row tint-bad">
        <td className="c-badge">
          <KindChip tone={item.tone}>{item.badge}</KindChip>
        </td>
        <Main title={item.title} detail={item.detail} />
        <td className="c-meta num">{item.runs === 1 ? "1 run" : `${item.runs} runs`}</td>
        <td className="c-when num">{fmtClock(item.at, now)}</td>
        <td className="c-act">
          <details className="att-fix">
            <summary aria-controls={fixId}>How to fix →</summary>
          </details>
        </td>
      </tr>
      <tr className="att-fix-row" id={fixId}>
        <td colSpan={5}>
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
      <Main title={`${item.agentId} · ${item.project}`} detail={item.detail} />
      <td className="c-meta mono">{item.model ? shortModel(item.model) : "–"}</td>
      <td className="c-meta num mono">{minutes(item.durationMs)}</td>
      <td className="c-when num">{fmtClock(item.at, now)}</td>
      <Act href={`/runs/${item.runId}`}>Open run →</Act>
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
      <Main title={`${item.name} · ${item.agentId}`} detail={item.detail} narrow={`Next fire if resumed: ${next}`} />
      <td className="c-when num">{fmtClock(item.at, now)}</td>
      <td className="c-meta num">{next}</td>
      <Act href={`/schedules#${item.scheduleId}`}>Open schedule →</Act>
    </tr>
  );
}

function BudgetRow({ item }: { item: BudgetItem }) {
  return (
    <tr className="att-row">
      <td className="c-badge">
        <KindChip tone={item.tone}>{item.badge}</KindChip>
      </td>
      <Main title={item.title} detail={item.detail} />
      <td className="c-meta num mono">
        {usd(item.countedUsd)} / {usd(item.amountUsd)}
      </td>
      <Act href="/costs">Open Costs →</Act>
    </tr>
  );
}

function BusyRow({ item, now }: { item: BusyItem; now: number }) {
  return (
    <tr className="att-row">
      <td className="c-badge">
        <KindChip tone={item.tone}>{item.badge}</KindChip>
      </td>
      <Main title={`${item.name} · ${item.agentId}`} detail={item.detail} />
      <td className="c-when num">{fmtClock(item.at, now)}</td>
      <Act href={`/schedules#${item.scheduleId}`}>Open schedule →</Act>
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
      return <BudgetRow item={item} />;
    case "busy":
      return <BusyRow item={item} now={now} />;
  }
}

/** The non-empty sections in their fixed order, one table each. */
export function AttentionSections({ sections, now }: { sections: AttentionSection[]; now: number }) {
  return (
    <>
      {sections.map((s) => (
        <section key={s.kind} className={`att-section att-${s.kind}`} aria-labelledby={`att-${s.kind}`}>
          <h2 id={`att-${s.kind}`} className="att-h2">
            {s.title} <span className="count">{s.items.length}</span>
          </h2>
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
              </tr>
            </thead>
            <tbody>
              {(s.items as AttentionItem[]).map((item) => (
                <Row key={item.key} item={item} now={now} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

/** Nothing in any section: a calm card instead of the tables, and no badge on the tab. */
export function AttentionEmpty({ now }: { now: number }) {
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
