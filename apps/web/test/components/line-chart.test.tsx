import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LineChart, type LineSeries } from "../../components/charts/LineChart";
import { END_LABEL_GAP } from "../../lib/trends";

function render(series: LineSeries[]): string {
  return renderToStaticMarkup(
    <LineChart
      ariaLabel="Clean rate"
      xTicks={[{ index: 2, label: "Oct" }]}
      buckets={3}
      y={{ min: 0, max: 100, ticks: [0, 50, 100], format: (v) => `${v}%` }}
      series={series}
      height={200}
    />,
  );
}

test("LineChart: an end label holds the name and the value in separate spans", () => {
  const html = render([
    { id: "rev", values: [90, 95, 98], tone: "primary", endLabel: { name: "reviewer", value: "98%" } },
  ]);
  assert.match(
    html,
    /<span class="tone-primary" data-agent="rev" style="top:[\d.]+px"><span class="end-name">reviewer<\/span><span class="end-value">98%<\/span><\/span>/,
  );
});

test("LineChart: end labels at the same height are spread a full line box apart", () => {
  const ids = ["a", "b", "c"];
  const html = render(
    ids.map((id) => ({ id, values: [50, 50, 50], tone: "faint" as const, endLabel: { name: id, value: "50%" } })),
  );
  const tops = [...html.matchAll(/data-agent="[abc]" style="top:([\d.]+)px"/g)].map((m) => Number(m[1]));
  assert.equal(tops.length, 3);
  const sorted = [...tops].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok((sorted[i] as number) - (sorted[i - 1] as number) >= END_LABEL_GAP);
  }
});
