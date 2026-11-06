import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NavSettings, NavTabs } from "../../components/NavTabs";
import { setPathname } from "../stubs/next-navigation";

/** The tab whose link carries aria-current, by its label. */
function current(html: string): string[] {
  return [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
}

test("NavTabs: Attention first, then the five sections; Runs active on / and on runs, trends and costs", () => {
  setPathname("/");
  const html = renderToStaticMarkup(<NavTabs />);
  assert.deepEqual(
    [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    ["/attention", "/", "/agents", "/projects", "/schedules", "/mcp"],
  );
  // no badge without items: the tab itself stays
  assert.match(html, /<a href="\/attention" class="tab ">Attention<\/a>/);
  assert.deepEqual(current(html), ["Runs"]);
  assert.match(html, /<a href="\/" class="tab active" aria-current="page">Runs<\/a>/);
  assert.match(html, /<a href="\/agents" class="tab ">Agents<\/a>/);
  for (const p of ["/runs/r1", "/trends", "/costs?range=30d"]) {
    setPathname(p);
    assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["Runs"], p);
  }
});

test("NavTabs: Attention active on /attention, its badge on the tab", () => {
  setPathname("/attention");
  const html = renderToStaticMarkup(<NavTabs attention={{ count: 3, tone: "bad" }} />);
  assert.match(
    html,
    /<a href="\/attention" class="tab active" aria-current="page">Attention<span class="nav-badge bad" title="3 items need you">/,
  );
  assert.match(html, /<a href="\/" class="tab ">Runs<\/a>/);
});

test("NavTabs: a section's sub-pages mark it; Settings marks none of the six", () => {
  setPathname("/agents/df-ui-developer");
  assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["Agents"]);
  setPathname("/projects");
  assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["Projects"]);
  setPathname("/schedules");
  assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["Schedules"]);
  setPathname("/mcp");
  assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["MCP"]);
  setPathname("/settings");
  assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), []);
});

test("NavTabs: no running run, no Runs badge (not a 0) and no has-badge class", () => {
  setPathname("/agents");
  for (const html of [renderToStaticMarkup(<NavTabs />), renderToStaticMarkup(<NavTabs running={0} />)]) {
    assert.doesNotMatch(html, /run-badge|has-badge|running/);
    assert.match(html, /<a href="\/" class="tab ">Runs<\/a>/);
  }
});

test("NavTabs: n running on another page, the Default Runs tab carries the badge n and a spoken count", () => {
  setPathname("/agents");
  const html = renderToStaticMarkup(<NavTabs running={2} />);
  assert.match(
    html,
    /<a href="\/" class="tab {2}has-badge">Runs<span class="run-badge" aria-hidden="true">2<\/span><span class="sr-only">, 2 running<\/span><\/a>/,
  );
  assert.equal([...html.matchAll(/run-badge|nav-badge/g)].length, 1, "only the Runs tab has a badge");
  assert.match(html, /<a href="\/agents" class="tab active" aria-current="page">Agents<\/a>/);
});

test("NavTabs: n running on /runs, the Runs tab is Active with the badge", () => {
  setPathname("/runs/r1");
  const html = renderToStaticMarkup(<NavTabs running={12} />);
  assert.match(
    html,
    /<a href="\/" class="tab active has-badge" aria-current="page">Runs<span class="run-badge" aria-hidden="true">12<\/span>/,
  );
});

test("NavTabs: before the first poll, the badge shows the layout's count", () => {
  setPathname("/schedules");
  assert.match(renderToStaticMarkup(<NavTabs running={1} />), /<span class="run-badge" aria-hidden="true">1<\/span>/);
});

test("NavTabs: Runs and Attention badges together, each on its own tab with its own class", () => {
  setPathname("/agents");
  const html = renderToStaticMarkup(<NavTabs running={3} attention={{ count: 2, tone: "warn" }} />);
  assert.match(
    html,
    /<a href="\/attention" class="tab ">Attention<span class="nav-badge warn" title="2 items need you">/,
  );
  assert.match(html, /<a href="\/" class="tab {2}has-badge">Runs<span class="run-badge" aria-hidden="true">3<\/span>/);
  assert.equal([...html.matchAll(/class="run-badge"/g)].length, 1);
  assert.equal([...html.matchAll(/class="nav-badge /g)].length, 1);
});

test("NavSettings: gear and label, active with aria-current only on /settings", () => {
  setPathname("/settings");
  const on = renderToStaticMarkup(<NavSettings />);
  assert.match(on, /^<a href="\/settings" class="tab nav-settings active" aria-current="page" aria-label="Settings">/);
  assert.match(on, /<svg [^>]*aria-hidden="true"/);
  assert.match(on, /<span class="label">Settings<\/span><\/a>$/);
  setPathname("/");
  const off = renderToStaticMarkup(<NavSettings />);
  assert.match(off, /^<a href="\/settings" class="tab nav-settings " aria-label="Settings">/);
  assert.doesNotMatch(off, /aria-current/);
});
