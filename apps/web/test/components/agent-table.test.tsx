import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentTable, type AgentTableRow } from "../../components/charts/AgentTable";

const row = (agentId: string, over: Partial<AgentTableRow> = {}): AgentTableRow => ({
  agentId,
  rate: "80%",
  delta: "−4",
  runs: "10",
  rates: [90, 85, 80],
  drawn: false,
  worst: false,
  checked: false,
  href: `/trends?agent=${agentId}`,
  ...over,
});

function render(rows: AgentTableRow[], props: Partial<Parameters<typeof AgentTable>[0]> = {}): string {
  return renderToStaticMarkup(
    <AgentTable
      rows={rows}
      selectable
      limitHint={null}
      q=""
      hidden={[]}
      expanded={false}
      showAllHref="/trends?all=1"
      {...props}
    />,
  );
}

const foot = (html: string) => /<div class="at-foot">(.*)<\/div><\/div>$/.exec(html)?.[1];

test("AgentTable: selectable rows are checkbox links that work without JS", () => {
  const html = render([row("alpha", { checked: true, drawn: true }), row("beta")]);
  assert.match(
    html,
    /<a data-agent="alpha" href="\/trends\?agent=alpha" role="checkbox" aria-checked="true" aria-label="alpha, clean 80%, change −4, 10 runs" class="at-row">/,
  );
  assert.match(html, /<span class="at-box on" aria-hidden="true"><svg/);
  assert.match(html, /aria-checked="false"[^>]*class="at-row"><span class="at-box" aria-hidden="true"><\/span>/);
  assert.match(html, /<span class="at-swatch tone-faint" aria-hidden="true"><\/span><span class="at-id">alpha<\/span>/);
  assert.match(html, /<span class="at-swatch" aria-hidden="true"><\/span><span class="at-id">beta<\/span>/);
  assert.equal(foot(html), "<span>ticks stay in ?agent=</span>");
});

test("AgentTable: the worst agent gets the accent swatch, Δ and sparkline", () => {
  const html = render([row("alpha", { drawn: true, worst: true })]);
  assert.match(html, /class="at-swatch tone-accent"/);
  assert.match(html, /<span class="at-delta worst">−4<\/span>/);
  assert.match(html, /<svg class="at-spark worst"/);
});

test("AgentTable: the sparkline breaks on a gap; a lone point is a dot", () => {
  const html = render([row("alpha", { rates: [100, 50, null, 0] })]);
  assert.match(html, /<polyline points="0\.0,0\.0 14\.7,7\.0"><\/polyline>/);
  assert.match(html, /<circle cx="44\.0" cy="14\.0" r="1"><\/circle>/);
});

test("AgentTable: tick limit reached, unticked rows are disabled and the hint replaces the foot", () => {
  const hint = "Up to 5 agents on the chart";
  const html = render([row("alpha", { checked: true }), row("beta", { href: null })], { limitHint: hint });
  assert.match(
    html,
    /<span data-agent="beta" tabindex="0" role="checkbox" aria-checked="false" aria-disabled="true" aria-label="beta, clean 80%, change −4, 10 runs\. Up to 5 agents on the chart" title="Up to 5 agents on the chart" class="at-row disabled">/,
  );
  assert.equal(foot(html), `<span>${hint}</span>`);
});

test("AgentTable: every agent drawn, no ticks and no checkbox roles", () => {
  const html = render([row("alpha", { drawn: true })], { selectable: false });
  assert.doesNotMatch(html, /role="checkbox"|at-box/);
  assert.match(
    html,
    /<span data-agent="alpha" tabindex="0" title="alpha, clean 80%, change −4, 10 runs" class="at-row">/,
  );
  assert.match(html, /<div class="at-head" aria-hidden="true"><span><\/span><span class="at-id">agent<\/span>/);
  assert.equal(foot(html), "<span>every agent is drawn</span>");
});

test("AgentTable: more than 8 rows, the rest marked extra, a scroll hint and Show all", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`a${i}`));
  const html = render(rows);
  assert.match(html, /^<div class="agent-table">/);
  assert.equal((html.match(/<li class="extra">/g) ?? []).length, 2);
  assert.equal(
    foot(html),
    '<span>↓ 2 more · scroll · ticks stay in ?agent=</span><a href="/trends?all=1" class="at-all">Show all 10 agents</a>',
  );
  const expanded = render(rows, { expanded: true });
  assert.match(expanded, /^<div class="agent-table expanded">/);
  assert.doesNotMatch(expanded, /Show all/);
});

test("AgentTable: the find field keeps ?q= and the page's params; no match says so", () => {
  const html = render([row("alpha")], { q: "zeta", hidden: [["range", "30d"]] });
  assert.match(
    html,
    /<form class="at-find" action="\/trends" method="get"><input type="hidden" name="range" value="30d"\/>/,
  );
  assert.match(html, /<input type="search" aria-label="Find agent" placeholder="Find agent…" name="q" value="zeta"\/>/);
  assert.match(html, /<li class="at-empty">No agent matches\.<\/li>/);
  assert.doesNotMatch(html, /data-agent="alpha"/);
});
