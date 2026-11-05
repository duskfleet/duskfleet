import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NavSettings, NavTabs } from "../../components/NavTabs";
import { setPathname } from "../stubs/next-navigation";

/** The tab whose link carries aria-current, by its label. */
function current(html: string): string[] {
  return [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
}

test("NavTabs: Attention first, then the four sections; Runs active on / and on runs, trends and costs", () => {
  setPathname("/");
  const html = renderToStaticMarkup(<NavTabs />);
  assert.deepEqual(
    [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    ["/attention", "/", "/agents", "/schedules", "/mcp"],
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
