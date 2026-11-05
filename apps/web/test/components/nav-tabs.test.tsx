import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NavSettings, NavTabs } from "../../components/NavTabs";
import { setPathname } from "../stubs/next-navigation";

/** The tab whose link carries aria-current, by its label. */
function current(html: string): string[] {
  return [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
}

test("NavTabs: the five sections in order, Runs active on / and on runs, trends and costs", () => {
  setPathname("/");
  const html = renderToStaticMarkup(<NavTabs />);
  assert.deepEqual(
    [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    ["/", "/agents", "/projects", "/schedules", "/mcp"],
  );
  assert.deepEqual(current(html), ["Runs"]);
  assert.match(html, /<a href="\/" class="tab active" aria-current="page">Runs<\/a>/);
  assert.match(html, /<a href="\/agents" class="tab ">Agents<\/a>/);
  for (const p of ["/runs/r1", "/trends", "/costs?range=30d"]) {
    setPathname(p);
    assert.deepEqual(current(renderToStaticMarkup(<NavTabs />)), ["Runs"], p);
  }
});

test("NavTabs: a section's sub-pages mark it; Settings marks none of the five", () => {
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
