import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type BarStack, StackedBars, type StackedBarsProps } from "../../components/charts/StackedBars";

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
    /<span class="tone-primary" data-row="a" style="top:[\d.]+px"><span class="end-name">alpha <\/span>\$2.00<\/span>/,
  );
  assert.match(html, /<span data-row="b" style="top:[\d.]+px"><span class="end-name">beta <\/span>\$2.00<\/span>/);
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
