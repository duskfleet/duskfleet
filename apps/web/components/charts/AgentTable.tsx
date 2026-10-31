"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

export type AgentTableRow = {
  agentId: string;
  rate: string;
  delta: string;
  runs: string;
  rates: ReadonlyArray<number | null>;
  /** Its line is on the chart (a swatch in the row). */
  drawn: boolean;
  /** The most-worsening agent: accent swatch, Δ and sparkline. */
  worst: boolean;
  checked: boolean;
  /** Server-built link that toggles this agent in ?agent=; null = the tick is disabled (limit reached). */
  href: string | null;
};

/** Rows shown on a narrow screen before "Show all N agents". */
const NARROW_ROWS = 8;
const SPARK_W = 44;
const SPARK_H = 14;

/**
 * The ranked agent table of the clean-rate panel (DS-23). Server-rendered rows whose ticks are
 * plain links (they work without JS); with JS a tick goes through router.replace, the find field
 * filters the rows as you type (GET ?q= without JS), and hovering or focusing a row highlights
 * the chart's series of the same `data-agent` in the enclosing `.rate-panel`.
 */
export function AgentTable({
  rows,
  selectable,
  limitHint,
  q,
  hidden,
  expanded,
  showAllHref,
}: {
  rows: AgentTableRow[];
  /** False when every agent is drawn: no ticks. */
  selectable: boolean;
  /** Shown when the tick limit is reached. */
  limitHint: string | null;
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

  const highlight = (agentId: string | null) => {
    const panel = ref.current?.closest(".rate-panel");
    if (!panel) return;
    for (const el of panel.querySelectorAll(".is-hl")) el.classList.remove("is-hl");
    panel.classList.toggle("has-hl", agentId !== null);
    if (agentId === null) return;
    for (const el of panel.querySelectorAll(`[data-agent="${CSS.escape(agentId)}"]`)) el.classList.add("is-hl");
  };

  const needle = query.trim().toLowerCase();
  // A tick keeps what is typed in the find field as ?q=, so the filtered table survives it.
  const go = (href: string) => {
    const url = new URL(href, window.location.origin);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };
  const visible = rows.filter((r) => !needle || r.agentId.toLowerCase().includes(needle));
  const more = Math.max(0, rows.length - NARROW_ROWS);

  const row = (r: AgentTableRow, i: number) => {
    const extra = !needle && i >= NARROW_ROWS ? " extra" : "";
    const cells = (
      <>
        {selectable && (
          <span className={`at-box${r.checked ? " on" : ""}`} aria-hidden="true">
            {r.checked && (
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M4 8.2l2.6 2.6L12 5.4" />
              </svg>
            )}
          </span>
        )}
        <span className={`at-swatch${r.drawn ? (r.worst ? " tone-accent" : " tone-faint") : ""}`} aria-hidden="true" />
        <span className="at-id">{r.agentId}</span>
        <span className="at-rate">{r.rate}</span>
        <span className={`at-delta${r.worst ? " worst" : ""}`}>{r.delta}</span>
        <span className="at-runs">{r.runs}</span>
        <Spark rates={r.rates} worst={r.worst} />
      </>
    );
    const hover = {
      "data-agent": r.agentId,
      onMouseEnter: () => highlight(r.agentId),
      onMouseLeave: () => highlight(null),
      onFocus: () => highlight(r.agentId),
      onBlur: () => highlight(null),
    };
    const label = `${r.agentId}, clean ${r.rate}, change ${r.delta}, ${r.runs} runs`;
    if (selectable && r.href) {
      const href = r.href;
      return (
        <li key={r.agentId} className={extra.trim() || undefined}>
          {/* biome-ignore lint/a11y/useSemanticElements: a link, so the tick works without JS */}
          <a
            {...hover}
            href={href}
            role="checkbox"
            aria-checked={r.checked}
            aria-label={label}
            className="at-row"
            onClick={(e) => {
              e.preventDefault();
              go(href);
            }}
            onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => {
              if (e.key === " ") {
                e.preventDefault();
                go(href);
              }
            }}
          >
            {cells}
          </a>
        </li>
      );
    }
    if (selectable) {
      // The tick limit is reached: still focusable, for the highlight and the hint.
      return (
        <li key={r.agentId} className={extra.trim() || undefined}>
          {/* biome-ignore lint/a11y/useSemanticElements: same row shape as the link rows */}
          <span
            {...hover}
            tabIndex={0}
            role="checkbox"
            aria-checked={r.checked}
            aria-disabled={true}
            aria-label={`${label}${limitHint ? `. ${limitHint}` : ""}`}
            title={limitHint ?? undefined}
            className="at-row disabled"
          >
            {cells}
          </span>
        </li>
      );
    }
    return (
      <li key={r.agentId} className={extra.trim() || undefined}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the keyboard gets the hover highlight */}
        <span {...hover} tabIndex={0} title={label} className="at-row">
          {cells}
        </span>
      </li>
    );
  };

  return (
    <div className={`agent-table${all ? " expanded" : ""}`} ref={ref}>
      <form
        action="/trends"
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
          aria-label="Find agent"
          placeholder="Find agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      <div className="at-head" aria-hidden="true">
        {selectable && <span />}
        <span />
        <span className="at-id">agent</span>
        <span className="at-rate">clean</span>
        <span className="at-delta" title="change over the period, in points">
          Δ
        </span>
        <span className="at-runs">runs</span>
        <span>trend</span>
      </div>
      <ul className="at-rows" aria-label="Agents, lowest clean rate first">
        {visible.map(row)}
        {visible.length === 0 && <li className="at-empty">No agent matches.</li>}
      </ul>
      <div className="at-foot">
        {limitHint ? (
          <span>{limitHint}</span>
        ) : (
          <span>
            {more > 0 && `↓ ${more} more · scroll · `}
            {selectable ? "ticks stay in ?agent=" : "every agent is drawn"}
          </span>
        )}
        {more > 0 && !all && !needle && (
          <a
            href={showAllHref}
            className="at-all"
            onClick={(e) => {
              e.preventDefault();
              setAll(true);
            }}
          >
            Show all {rows.length} agents
          </a>
        )}
      </div>
    </div>
  );
}

/** 0–100 % sparkline; a gap breaks the line. */
function Spark({ rates, worst }: { rates: ReadonlyArray<number | null>; worst: boolean }) {
  const step = rates.length > 1 ? SPARK_W / (rates.length - 1) : 0;
  const lines: string[] = [];
  let cur: string[] = [];
  rates.forEach((v, i) => {
    if (v === null) {
      if (cur.length) lines.push(cur.join(" "));
      cur = [];
    } else cur.push(`${(i * step).toFixed(1)},${(SPARK_H - (v / 100) * SPARK_H).toFixed(1)}`);
  });
  if (cur.length) lines.push(cur.join(" "));
  return (
    <svg
      className={`at-spark${worst ? " worst" : ""}`}
      viewBox={`-1 -1 ${SPARK_W + 2} ${SPARK_H + 2}`}
      width={SPARK_W}
      height={SPARK_H}
      aria-hidden="true"
      focusable="false"
    >
      {lines.map((p) =>
        p.includes(" ") ? (
          <polyline key={p} points={p} />
        ) : (
          <circle key={p} cx={p.split(",")[0]} cy={p.split(",")[1]} r={1} />
        ),
      )}
    </svg>
  );
}
