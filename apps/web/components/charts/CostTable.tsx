"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

export type CostTableRow = {
  /** The row's key in the URL and on the chart's `data-row`. */
  key: string;
  label: string;
  /** Title of the name, e.g. the full model id or the project path. */
  title?: string;
  spent: string;
  share: string;
  runs: string;
  avg: string;
  /** Swatch of its segment: accent (rank 1 of the ticked), faint, or none (folded into "others"). */
  tone: "accent" | "faint" | null;
  checked: boolean;
  /** Server-built link that toggles this row in the URL. */
  tickHref: string;
  /** Where the name goes (agent page, Runs filtered); null = plain text. */
  nameHref: string | null;
  /** Where the runs count goes; null = plain text. */
  runsHref: string | null;
};

export type CostSplitOption = { key: string; label: string; href: string; on: boolean };

/** Rows shown on a narrow screen before "Show all N". */
const NARROW_ROWS = 7;

/**
 * The ranked table of the /costs panel (DS-27): a find field, the split control in its head,
 * one row per agent, project or model with a tick that decides what the chart draws, and a
 * sticky total row. Ticks are plain links (they work without JS); with JS they go through
 * router.replace, the find field filters as you type, and hovering or focusing a row (or a bar
 * segment) highlights the segments of the same `data-row` in the enclosing `.cost-panel`.
 */
export function CostTable({
  rows,
  noun,
  plural,
  splits,
  total,
  param,
  q,
  hidden,
  expanded,
  showAllHref,
}: {
  rows: CostTableRow[];
  /** "agent", "project", "model": the first column's head. */
  noun: string;
  plural: string;
  splits: CostSplitOption[];
  total: { spent: string; share: string; runs: string; avg: string };
  /** The URL param the ticks live in, for the foot note. */
  param: string;
  q: string;
  /** The page's other params, kept by the no-JS find form. */
  hidden: Array<[string, string]>;
  expanded: boolean;
  showAllHref: string;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState(q);
  const [all, setAll] = useState(expanded);
  useEffect(() => setMounted(true), []);

  // Hovering a bar segment highlights its row's segments too, as hovering the row does.
  useEffect(() => {
    const panel = ref.current?.closest(".cost-panel");
    const plot = panel?.querySelector(".bar-chart");
    if (!plot) return;
    const over = (e: Event) => {
      const row = (e.target as Element | null)?.closest?.("[data-row]")?.getAttribute("data-row");
      highlight(row ?? null);
    };
    const out = () => highlight(null);
    plot.addEventListener("mouseover", over);
    plot.addEventListener("mouseleave", out);
    return () => {
      plot.removeEventListener("mouseover", over);
      plot.removeEventListener("mouseleave", out);
    };
  });

  const highlight = (key: string | null) => {
    const panel = ref.current?.closest(".cost-panel");
    if (!panel) return;
    for (const el of panel.querySelectorAll(".is-hl")) el.classList.remove("is-hl");
    panel.classList.toggle("has-hl", key !== null);
    if (key === null) return;
    for (const el of panel.querySelectorAll(`[data-row="${CSS.escape(key)}"]`)) el.classList.add("is-hl");
  };

  const needle = query.trim().toLowerCase();
  // A tick keeps what is typed in the find field as ?q=, so the filtered table survives it.
  const go = (href: string) => {
    const url = new URL(href, window.location.origin);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };
  const visible = rows.filter((r) => !needle || r.label.toLowerCase().includes(needle));
  const more = Math.max(0, rows.length - NARROW_ROWS);

  const row = (r: CostTableRow, i: number) => {
    const extra = !needle && i >= NARROW_ROWS ? "extra" : undefined;
    return (
      <li
        key={r.key}
        className={extra}
        data-row={r.key}
        onMouseEnter={() => highlight(r.key)}
        onMouseLeave={() => highlight(null)}
        onFocus={() => highlight(r.key)}
        onBlur={() => highlight(null)}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: a link, so the tick works without JS */}
        <a
          href={r.tickHref}
          role="checkbox"
          aria-checked={r.checked}
          aria-label={`Draw ${r.label}`}
          className={`at-box${r.checked ? " on" : ""}`}
          onClick={(e) => {
            e.preventDefault();
            go(r.tickHref);
          }}
          onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => {
            if (e.key === " ") {
              e.preventDefault();
              go(r.tickHref);
            }
          }}
        >
          {r.checked && (
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M4 8.2l2.6 2.6L12 5.4" />
            </svg>
          )}
        </a>
        <span className={`ct-swatch${r.tone ? ` tone-${r.tone}` : ""}`} aria-hidden="true" />
        {r.nameHref ? (
          <a href={r.nameHref} className="ct-name" title={r.title}>
            {r.label}
          </a>
        ) : (
          <span className="ct-name" title={r.title}>
            {r.label}
          </span>
        )}
        <span className="ct-num">{r.spent}</span>
        <span className="ct-num">{r.share}</span>
        {r.runsHref ? (
          <a href={r.runsHref} className="ct-num ct-runs" aria-label={`${r.runs} runs of ${r.label}`}>
            {r.runs}
          </a>
        ) : (
          <span className="ct-num ct-runs">{r.runs}</span>
        )}
        <span className="ct-num ct-avg">{r.avg}</span>
      </li>
    );
  };

  return (
    <div className={`cost-table${all ? " expanded" : ""}`} ref={ref}>
      <div className="ct-tools">
        <form
          action="/costs"
          method="get"
          className="at-find"
          onSubmit={(e) => {
            if (mounted) e.preventDefault();
          }}
        >
          {hidden.map(([k, v]) => (
            <input key={`${k}=${v}`} type="hidden" name={k} value={v} />
          ))}
          <input
            type="search"
            name="q"
            aria-label={`Find ${noun}`}
            placeholder={`Find ${noun}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <nav className="ct-split" aria-label="Split">
          {splits.map((s) => (
            <a key={s.key} href={s.href} className={s.on ? "on" : undefined} aria-current={s.on ? "true" : undefined}>
              {s.label}
            </a>
          ))}
        </nav>
      </div>
      <div className="ct-head" aria-hidden="true">
        <span />
        <span />
        <span className="ct-name">{noun}</span>
        <span className="ct-num">spent</span>
        <span className="ct-num">share</span>
        <span className="ct-num ct-runs">runs</span>
        <span className="ct-num ct-avg">avg/run</span>
      </div>
      <ul className="ct-rows" aria-label={`${plural}, biggest spender first`}>
        {visible.map(row)}
        {visible.length === 0 && <li className="at-empty">No {noun} matches.</li>}
      </ul>
      {more > 0 && !needle && (
        <div className="ct-more">
          <span>
            ↓ {more} more · scroll · ticks stay in ?{param}=
          </span>
        </div>
      )}
      <div className="ct-total">
        <span />
        <span />
        <span className="ct-name">
          all {rows.length} {rows.length === 1 ? noun : plural}
        </span>
        <span className="ct-num">{total.spent}</span>
        <span className="ct-num">{total.share}</span>
        <span className="ct-num ct-runs">{total.runs}</span>
        <span className="ct-num ct-avg">{total.avg}</span>
      </div>
      {more > 0 && !all && !needle && (
        <a
          href={showAllHref}
          className="at-all"
          onClick={(e) => {
            e.preventDefault();
            setAll(true);
          }}
        >
          Show all {rows.length} {plural}
        </a>
      )}
    </div>
  );
}
