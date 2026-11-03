import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type CostSplitOption, CostTable, type CostTableRow } from "../../components/charts/CostTable";

const row = (key: string, over: Partial<CostTableRow> = {}): CostTableRow => ({
  key,
  label: key,
  spent: "$1.00",
  share: "10%",
  runs: "4",
  avg: "$0.25",
  tone: null,
  checked: false,
  tickHref: `/costs?agent=${key}`,
  nameHref: `/agents/${key}`,
  runsHref: `/?agent=${key}`,
  ...over,
});

const splits: CostSplitOption[] = [
  { key: "agent", label: "agent", href: "/costs", on: true },
  { key: "project", label: "project", href: "/costs?by=project", on: false },
  { key: "model", label: "model", href: "/costs?by=model", on: false },
];

function render(rows: CostTableRow[], props: Partial<Parameters<typeof CostTable>[0]> = {}): string {
  return renderToStaticMarkup(
    <CostTable
      rows={rows}
      noun="agent"
      plural="agents"
      splits={splits}
      total={{ spent: "$10.00", share: "100%", runs: "40", avg: "$0.25" }}
      param="agent"
      q=""
      hidden={[]}
      expanded={false}
      showAllHref="/costs?all=1"
      {...props}
    />,
  );
}

test("CostTable: a ticked row is a checked checkbox link with its segment's swatch", () => {
  const html = render([row("alpha", { checked: true, tone: "accent" }), row("beta", { checked: true, tone: "faint" })]);
  assert.match(
    html,
    /<a href="\/costs\?agent=alpha" role="checkbox" aria-checked="true" aria-label="Draw alpha" class="at-box on"><svg/,
  );
  assert.match(html, /<span class="ct-swatch tone-accent" aria-hidden="true"><\/span><a href="\/agents\/alpha"/);
  assert.match(html, /<span class="ct-swatch tone-faint" aria-hidden="true"><\/span><a href="\/agents\/beta"/);
});

test("CostTable: an unticked row has an empty box and no swatch colour", () => {
  const html = render([row("gamma")]);
  assert.match(html, /role="checkbox" aria-checked="false" aria-label="Draw gamma" class="at-box"><\/a>/);
  assert.match(html, /<span class="ct-swatch" aria-hidden="true"><\/span>/);
});

test("CostTable: the split control sits in the table head, the active split marked", () => {
  const html = render([row("alpha")]);
  assert.match(
    html,
    /<nav class="ct-split" aria-label="Split"><a href="\/costs" class="on" aria-current="true">agent<\/a>/,
  );
  assert.match(html, /<a href="\/costs\?by=model">model<\/a>/);
});

test("CostTable: columns spent, share, runs (linked) and avg/run, then the total row", () => {
  const html = render([row("alpha")]);
  assert.match(
    html,
    /<span class="ct-num">\$1.00<\/span><span class="ct-num">10%<\/span><a href="\/\?agent=alpha" class="ct-num ct-runs" aria-label="4 runs of alpha">4<\/a><span class="ct-num ct-avg">\$0.25<\/span>/,
  );
  assert.match(
    html,
    /<div class="ct-total">.*<span class="ct-name">all 1 agent<\/span><span class="ct-num">\$10.00<\/span>/,
  );
});

test("CostTable: rows without a link target render plain text", () => {
  const html = render([row("opus 4.5", { nameHref: null, runsHref: null, title: "claude-opus-4-5" })]);
  assert.match(html, /<span class="ct-name" title="claude-opus-4-5">opus 4.5<\/span>/);
  assert.match(html, /<span class="ct-num ct-runs">4<\/span>/);
});

test("CostTable: past 7 rows a scroll note and a Show all link", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row(`a${i}`));
  const html = render(rows);
  assert.match(html, /↓ 2 more · scroll · ticks stay in \?agent=/);
  assert.match(html, /<a href="\/costs\?all=1" class="at-all">Show all 9 agents<\/a>/);
  assert.match(html, /<li class="extra" data-row="a7">/);
});

test("CostTable: the find field filters on the server render too", () => {
  const html = render([row("alpha"), row("beta")], { q: "alp" });
  assert.match(html, /data-row="alpha"/);
  assert.doesNotMatch(html, /data-row="beta"/);
  const none = render([row("alpha")], { q: "zzz" });
  assert.match(none, /No agent matches\./);
});
