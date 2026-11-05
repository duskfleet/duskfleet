import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type BarStack, StackedBars, type StackedBarsProps } from "../../components/charts/StackedBars";
import { END_LABEL_GAP, END_LABEL_LINE } from "../../lib/trends";

function render(stacks: BarStack[], props: Partial<StackedBarsProps> = {}): string {
  return renderToStaticMarkup(
    <StackedBars
      ariaLabel="Spend"
      names={["1 Oct", "2 Oct"]}
      xTicks={[{ index: 1, label: "2 Oct" }]}
      stacks={stacks}
      y={{ max: 4, ticks: [0, 2, 4] }}
      height={200}
      {...props}
    />,
  );
}

test("StackedBars: nothing ticked draws one faint total segment per bar, no others", () => {
  const html = render([{ key: "__total", label: "all", tone: "faint", values: [1, 2], row: null }]);
  assert.equal((html.match(/class="chart-bar tone-faint"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /tone-others|tone-accent/);
});

test("StackedBars: one ticked row is the accent with an outlined others segment on top", () => {
  const html = render([
    { key: "a", label: "a", tone: "accent", values: [1, 1], row: "a" },
    { key: "__others", label: "others", tone: "others", values: [1, 1], row: null },
  ]);
  assert.match(html, /<rect class="chart-bar tone-accent" data-row="a"/);
  assert.match(html, /<rect class="chart-bar tone-others" x=/);
});

test("StackedBars: end labels name each stack beside the last bar, the first one strong", () => {
  const html = render(
    [
      { key: "a", label: "a", tone: "accent", values: [1, 1], row: "a" },
      { key: "b", label: "b", tone: "faint", values: [1, 1], row: "b" },
    ],
    {
      ends: [
        { key: "a", name: "alpha", value: "$2.00", strong: true },
        { key: "b", name: "beta", value: "$2.00" },
      ],
    },
  );
  assert.match(html, /<div class="chart-ends bar-ends"/);
  assert.match(
    html,
    /<span class="tone-primary" data-row="a" style="top:[\d.]+px"><span class="end-name">alpha<\/span><span class="end-value">\$2.00<\/span><\/span>/,
  );
  assert.match(
    html,
    /<span data-row="b" style="top:[\d.]+px"><span class="end-name">beta<\/span><span class="end-value">\$2.00<\/span><\/span>/,
  );
});

test("StackedBars: six end labels bunched within 40 px are spread a full line box apart", () => {
  // Six thin segments at the bottom of the last bar: their centres fall within a few px.
  const keys = ["a", "b", "c", "d", "e", "f"];
  const html = render(
    keys.map((k) => ({ key: k, label: k, tone: "faint" as const, values: [0, 0.1], row: k })),
    { ends: keys.map((k) => ({ key: k, name: `agent-${k}`, value: "$0.10" })) },
  );
  const tops = [...html.matchAll(/data-row="[a-f]" style="top:([\d.]+)px"/g)].map((m) => Number(m[1]));
  assert.equal(tops.length, 6);
  const sorted = [...tops].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok((sorted[i] as number) - (sorted[i - 1] as number) >= END_LABEL_GAP, `labels ${i - 1} and ${i}`);
  }
  assert.ok(END_LABEL_GAP >= END_LABEL_LINE);
});

test("StackedBars: a long end label keeps its value whole, only the name can be truncated", () => {
  const html = render([{ key: "a", label: "a", tone: "accent", values: [1, 1], row: "a" }], {
    ends: [{ key: "a", name: "df-back-end-developer-with-a-very-long-name", value: "$236.79" }],
  });
  assert.match(
    html,
    /<span class="end-name">df-back-end-developer-with-a-very-long-name<\/span><span class="end-value">\$236.79<\/span>/,
  );
});

test("StackedBars: no budget draws no rule; a budget draws the dashed and dotted rules with labels", () => {
  const stacks: BarStack[] = [{ key: "a", label: "a", tone: "accent", values: [1, 1] }];
  assert.doesNotMatch(render(stacks), /chart-rule/);
  const html = render(stacks, {
    rules: [
      { value: 3, tone: "budget", label: "budget $90 a month" },
      { value: 2.4, tone: "warn", label: "warn 80%" },
    ],
  });
  assert.match(html, /class="chart-rule rule-budget"/);
  assert.match(html, /<span class="chart-rule-label rule-warn" style="top:(39\.9|40)[\d.]*%">warn 80%<\/span>/);
});
