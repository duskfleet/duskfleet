/**
 * Stacked bar chart, server-rendered: one SVG stretched to the plot (rects survive the
 * stretch), text in HTML placed in percent. The first stack sits at the bottom. Colours come
 * from the tones in globals.css (.chart-*), never from here.
 */

import { spreadLabels } from "@/lib/trends";

/** "others": the unticked rows of /costs folded into one outlined segment. */
export type BarTone = "ok" | "warn" | "muted" | "accent" | "faint" | "others";

export interface BarStack {
  key: string;
  label: string;
  tone: BarTone;
  values: ReadonlyArray<number>;
  /** Table row it draws (`data-row`), for the hover highlight of /costs. */
  row?: string | null;
}

/** A label at the right of the plot, beside its stack's segment of the last bar. */
export interface BarEnd {
  /** The stack it names (same key). */
  key: string;
  name: string;
  value: string;
  strong?: boolean;
}

/** A horizontal reference across the plot: the budget (dashed) or its warning threshold (dotted). */
export interface BarRule {
  value: number;
  tone: "budget" | "warn";
  label: string;
}

export interface StackedBarsProps {
  ariaLabel: string;
  /** Bucket labels, one per bar, for the hover titles. */
  names: ReadonlyArray<string>;
  xTicks: ReadonlyArray<{ index: number; label: string }>;
  stacks: ReadonlyArray<BarStack>;
  y: { max: number; ticks: ReadonlyArray<number> };
  /** Plot height in px. */
  height: number;
  /** How y ticks and hover values read (default: the number as is). */
  format?: (v: number) => string;
  /** A label above each bar (null = none), e.g. its total. */
  topLabels?: ReadonlyArray<string | null>;
  rules?: ReadonlyArray<BarRule>;
  /** Labels at the right of the plot (none: no end column). */
  ends?: ReadonlyArray<BarEnd>;
}

/** Share of a bar slot left empty between two bars. */
const SLOT_GAP = 0.2;
/** Minimum distance between two end labels, px (one line of text). */
const END_GAP = 18;

export function StackedBars({
  ariaLabel,
  names,
  xTicks,
  stacks,
  y,
  height,
  format = String,
  topLabels,
  rules = [],
  ends,
}: StackedBarsProps) {
  const n = names.length;
  const yPct = (v: number) => (1 - v / y.max) * 100;
  const center = (i: number) => ((i + 0.5) / n) * 100;
  const total = (i: number) => stacks.reduce((sum, s) => sum + (s.values[i] ?? 0), 0);
  // End labels sit beside their segment of the last bar that has one (the current bucket may be empty).
  let lastBar = n - 1;
  while (lastBar > 0 && total(lastBar) <= 0) lastBar--;
  const mids = new Map<string, number>();
  let acc = 0;
  for (const s of stacks) {
    const v = s.values[lastBar] ?? 0;
    mids.set(s.key, acc + v / 2);
    acc += v;
  }
  const placed = spreadLabels(
    (ends ?? []).map((e) => ({ ...e, top: (yPct(mids.get(e.key) ?? 0) / 100) * height })),
    END_GAP,
    height,
  );
  const rowOf = new Map(stacks.map((s) => [s.key, s.row ?? null]));
  return (
    <div className="chart bar-chart" role="img" aria-label={ariaLabel}>
      <div className="chart-y" style={{ height }} aria-hidden="true">
        {y.ticks.map((t) => (
          <span key={t} style={{ top: `${yPct(t)}%` }}>
            {format(t)}
          </span>
        ))}
      </div>
      <div className="chart-plot" style={{ height }}>
        <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {y.ticks.map((t) => (
            <line key={t} className="chart-grid" x1={0} x2={n} y1={yPct(t)} y2={yPct(t)} />
          ))}
          {names.map((name, i) => {
            let base = 0;
            return stacks.map((s) => {
              const v = s.values[i] ?? 0;
              const from = base;
              base += v;
              if (v <= 0) return null;
              return (
                <rect
                  key={`${s.key}-${name}`}
                  className={`chart-bar tone-${s.tone}`}
                  data-row={s.row ?? undefined}
                  x={i + SLOT_GAP / 2}
                  width={1 - SLOT_GAP}
                  y={yPct(base)}
                  height={yPct(from) - yPct(base)}
                >
                  <title>{`${name}: ${format(v)} ${s.label}`}</title>
                </rect>
              );
            });
          })}
          {rules.map((r) => (
            <line
              key={r.tone}
              className={`chart-rule rule-${r.tone}`}
              x1={0}
              x2={n}
              y1={yPct(r.value)}
              y2={yPct(r.value)}
            />
          ))}
        </svg>
        {topLabels?.map((label, i) =>
          label ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: one label per bar, in bar order
              key={i}
              className="chart-top"
              style={{ left: `${center(i)}%`, top: `${yPct(total(i))}%` }}
              aria-hidden="true"
            >
              {label}
            </span>
          ) : null,
        )}
        {rules.map((r) => (
          <span key={r.tone} className={`chart-rule-label rule-${r.tone}`} style={{ top: `${yPct(r.value)}%` }}>
            {r.label}
          </span>
        ))}
      </div>
      <div className={`chart-ends${ends?.length ? " bar-ends" : ""}`} style={{ height }} aria-hidden="true">
        {placed.map((e) => {
          const row = rowOf.get(e.key);
          return (
            <span
              key={e.key}
              className={e.strong ? "tone-primary" : undefined}
              data-row={row ?? undefined}
              style={{ top: e.top }}
            >
              <span className="end-name">{e.name} </span>
              {e.value}
            </span>
          );
        })}
      </div>
      <div className="chart-x" aria-hidden="true">
        {xTicks.map((t) => (
          <span key={t.index} style={{ left: `${center(t.index)}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Colour key of a chart: a square per stack. */
export function ChartLegend({ items }: { items: ReadonlyArray<{ key: string; label: string; tone: BarTone }> }) {
  return (
    <ul className="chart-legend">
      {items.map((it) => (
        <li key={it.key}>
          <span className={`swatch tone-${it.tone}`} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
