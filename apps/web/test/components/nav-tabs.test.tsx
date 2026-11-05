import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NavSettings, NavTabs } from "../../components/NavTabs";
import { setPathname } from "../stubs/next-navigation";

/** The tab whose link carries aria-current, by its label. */
function current(html: string): string[] {
  return [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
}

test("NavTabs: the four sections in order, Runs active on / and on runs, trends and costs", () => {
  setPathname("/");
  const html = renderToStaticMarkup(<NavTabs />);
  assert.deepEqual(
    [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    ["/", "/agents", "/schedules", "/mcp"],
  );
  assert.deepEqual(current(html), ["Runs"]);
  assert.match(html, /<a href="\/" class="tab active" aria-current="page">Runs<\/a>/);
  assert.match(html, /<a href="\/agents" class="tab ">Agents<\/a>/);
  for (const p of ["/runs/r1", "/trends", "/costs?range=30d"]) {
    setPathname(p);
    assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["Runs"], p);
  }
});

test("NavTabs: a section's sub-pages mark it; Settings marks none of the four", () => {
  setPathname("/agents/df-ui-developer");
  assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["Agents"]);
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
    assert.doesNotMatch(html, /nav-badge|has-badge|running/);
    assert.match(html, /<a href="\/" class="tab ">Runs<\/a>/);
  }
});

test("NavTabs: n running on another page, the Default Runs tab carries the badge n and a spoken count", () => {
  setPathname("/agents");
  const html = renderToStaticMarkup(<NavTabs running={2} />);
  assert.match(
    html,
    /<a href="\/" class="tab {2}has-badge">Runs<span class="nav-badge" aria-hidden="true">2<\/span><span class="sr-only">, 2 running<\/span><\/a>/,
  );
  assert.equal([...html.matchAll(/nav-badge/g)].length, 1, "only the Runs tab has a badge");
  assert.match(html, /<a href="\/agents" class="tab active" aria-current="page">Agents<\/a>/);
});

test("NavTabs: n running on /runs, the Runs tab is Active with the badge", () => {
  setPathname("/runs/r1");
  const html = renderToStaticMarkup(<NavTabs running={12} />);
  assert.match(
    html,
    /<a href="\/" class="tab active has-badge" aria-current="page">Runs<span class="nav-badge" aria-hidden="true">12<\/span>/,
  );
});

test("NavTabs: before the first poll, the badge shows the layout's count", () => {
  setPathname("/schedules");
  assert.match(renderToStaticMarkup(<NavTabs running={1} />), /<span class="nav-badge" aria-hidden="true">1<\/span>/);
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
