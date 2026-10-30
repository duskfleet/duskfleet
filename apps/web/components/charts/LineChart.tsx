import type { ReactNode } from "react";
import { pointIndexes, spreadLabels } from "@/lib/trends";

/**
 * Line chart, server-rendered: the lines and the grid are one SVG stretched to the plot
 * (non-scaling strokes), the text and the dots are HTML placed in percent of the plot, so
 * nothing is distorted at any width. Colours come from the tones in globals.css (.chart-*).
 */

export type LineTone = "primary" | "faint" | "accent";

export interface LineSeries {
  id: string;
  /** One value per bucket; null leaves a gap (no finished run in that bucket). */
  values: ReadonlyArray<number | null>;
  tone: LineTone;
  /** Text at the end of the line ("reviewer 98%"); none = no end label. */
  endLabel?: string;
}

export interface LineChartProps {
  ariaLabel: string;
  /** Labels under the plot: bucket index → text. */
  xTicks: ReadonlyArray<{ index: number; label: string }>;
  buckets: number;
  y: { min: number; max: number; ticks: ReadonlyArray<number>; format: (v: number) => string };
  series: ReadonlyArray<LineSeries>;
  /** Plot height in px. */
  height: number;
  /** A flat band over buckets [0, toIndex): the months before the first run. */
  band?: { toIndex: number; label: string };
  /** A line of text inside the plot, near its bottom (the worsening agent). */
  callout?: ReactNode;
}

/** A series with fewer points than this is drawn as dots, not a line. */
const MIN_LINE_POINTS = 3;
const LABEL_GAP = 17;

export function LineChart({ ariaLabel, xTicks, buckets, y, series, height, band, callout }: LineChartProps) {
  const x = (i: number) => (buckets <= 1 ? 50 : (i / (buckets - 1)) * 100);
  const yPct = (v: number) => ((y.max - Math.min(y.max, Math.max(y.min, v))) / (y.max - y.min)) * 100;
  // The overall line last, so it is drawn on top of the agents.
  const ordered = [...series].sort((a, b) => toneOrder(a.tone) - toneOrder(b.tone));

  const ends = spreadLabels(
    ordered.flatMap((s) => {
      const idx = pointIndexes(s.values);
      const last = idx.at(-1);
      if (last === undefined || !s.endLabel) return [];
      return [{ id: s.id, tone: s.tone, label: s.endLabel, top: (yPct(s.values[last] as number) / 100) * height }];
    }),
    LABEL_GAP,
    height,
  );

  return (
    <div className="chart line-chart" role="img" aria-label={ariaLabel}>
      <div className="chart-y" style={{ height }} aria-hidden="true">
        {y.ticks.map((t) => (
          <span key={t} style={{ top: `${yPct(t)}%` }}>
            {y.format(t)}
          </span>
        ))}
      </div>
      <div className="chart-plot" style={{ height }}>
        {band && band.toIndex > 0 && (
          <div
            className="chart-band"
            style={{ left: 0, width: `${Math.max(0, x(band.toIndex) - 50 / Math.max(1, buckets - 1))}%` }}
          >
            <span>{band.label}</span>
          </div>
        )}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {y.ticks.map((t) => (
            <line key={t} className="chart-grid" x1={0} x2={100} y1={yPct(t)} y2={yPct(t)} />
          ))}
          {ordered.flatMap((s) =>
            pointIndexes(s.values).length < MIN_LINE_POINTS
              ? []
              : segments(s.values).map((seg) => (
                  <polyline
                    key={`${s.id}-${seg[0]?.[0]}`}
                    className={`chart-line tone-${s.tone}`}
                    points={seg.map(([i, v]) => `${x(i)},${yPct(v)}`).join(" ")}
                  />
                )),
          )}
        </svg>
        {ordered.flatMap((s) => {
          const idx = pointIndexes(s.values);
          // Short series: every point is a dot. Lines: a dot at the end only.
          const dots = idx.length < MIN_LINE_POINTS ? idx : idx.slice(-1);
          return dots.map((i) => (
            <span
              key={`${s.id}-${i}`}
              className={`chart-dot tone-${s.tone}`}
              style={{ left: `${x(i)}%`, top: `${yPct(s.values[i] as number)}%` }}
              aria-hidden="true"
            />
          ));
        })}
        {callout && <div className="chart-callout">{callout}</div>}
      </div>
      <div className="chart-ends" style={{ height }} aria-hidden="true">
        {ends.map((e) => (
          <span key={e.id} className={`tone-${e.tone}`} style={{ top: e.top }}>
            {e.label}
          </span>
        ))}
      </div>
      <div className="chart-x" aria-hidden="true">
        {xTicks.map((t) => (
          <span key={t.index} style={{ left: `${x(t.index)}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function toneOrder(tone: LineTone): number {
  return tone === "faint" ? 0 : tone === "accent" ? 1 : 2;
}

/** Runs of consecutive non-null values, as [index, value] pairs: a gap breaks the line. */
function segments(values: ReadonlyArray<number | null>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push([i, v]);
  });
  if (cur.length) out.push(cur);
  return out;
}
