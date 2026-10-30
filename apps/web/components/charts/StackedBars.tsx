/**
 * Stacked bar chart, server-rendered: one SVG stretched to the plot (rects survive the
 * stretch), text in HTML placed in percent. The first stack sits at the bottom. Colours come
 * from the tones in globals.css (.chart-*), never from here.
 */

export type BarTone = "ok" | "warn" | "muted";

export interface BarStack {
  key: string;
  label: string;
  tone: BarTone;
  values: ReadonlyArray<number>;
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
}

/** Share of a bar slot left empty between two bars. */
const SLOT_GAP = 0.2;

export function StackedBars({ ariaLabel, names, xTicks, stacks, y, height }: StackedBarsProps) {
  const n = names.length;
  const yPct = (v: number) => (1 - v / y.max) * 100;
  const center = (i: number) => ((i + 0.5) / n) * 100;
  return (
    <div className="chart bar-chart" role="img" aria-label={ariaLabel}>
      <div className="chart-y" style={{ height }} aria-hidden="true">
        {y.ticks.map((t) => (
          <span key={t} style={{ top: `${yPct(t)}%` }}>
            {t}
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
                  x={i + SLOT_GAP / 2}
                  width={1 - SLOT_GAP}
                  y={yPct(base)}
                  height={yPct(from) - yPct(base)}
                >
                  <title>{`${name}: ${v} ${s.label}`}</title>
                </rect>
              );
            });
          })}
        </svg>
      </div>
      <div className="chart-ends" aria-hidden="true" />
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
