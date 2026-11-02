import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MultiSelect, type MultiSelectOption } from "../../components/MultiSelect";
import { setSearch } from "../stubs/next-navigation";

const opt = (value: string, group?: string): MultiSelectOption => ({
  value,
  label: value,
  group,
  href: `/?agent=${value}`,
});
const OPTIONS = [opt("alpha", "web"), opt("beta", "web"), opt("gamma", "core"), opt("solo")];

function render(selected: string[], options = OPTIONS): string {
  setSearch(selected.map((v) => `agent=${v}`).join("&"));
  return renderToStaticMarkup(
    <MultiSelect
      param="agent"
      label="Agent"
      noun="agents"
      options={options}
      selected={selected}
      clearHref="/"
      selectAllHref="/?agent=all"
    />,
  );
}

/** Each option row: its label and aria-selected. */
function rows(html: string): Array<[string, boolean]> {
  return [...html.matchAll(/role="option" aria-selected="(true|false)"[^>]*>.*?<\/span>([^<]*)<\/a>/g)].map((m) => [
    m[2],
    m[1] === "true",
  ]);
}

function groups(html: string): string[] {
  return [...html.matchAll(/<div class="ms-group"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]);
}

test("MultiSelect: nothing selected, the summary says all, no count and no clear link", () => {
  const html = render([]);
  assert.match(html, /^<div class="ms ">/);
  assert.match(html, /<span class="ms-label">Agent<\/span><span class="ms-values">all<\/span>/);
  assert.match(html, /role="combobox" aria-haspopup="listbox" aria-expanded="false"/);
  assert.doesNotMatch(html, /ms-count"|ms-clear"/);
  assert.match(html, /<span>0 of 4 selected<\/span>/);
});

test("MultiSelect: closed list is server-rendered links (no JS), grouped by project, ungrouped last", () => {
  const html = render([]);
  assert.match(html, /<details>/);
  assert.deepEqual(groups(html), ["web · 2", "core · 1"]);
  assert.deepEqual(rows(html), [
    ["alpha", false],
    ["beta", false],
    ["gamma", false],
    ["solo", false],
  ]);
  assert.match(html, /href="\/\?agent=alpha" tabindex="-1" class="ms-option {2}"/);
  assert.match(html, /<a href="\/\?agent=all">Select all<\/a><a href="\/">Clear<\/a>/);
  // The type-ahead and the key hint need JS: not in the server markup.
  assert.doesNotMatch(html, /ms-filter|ms-hint/);
});

test("MultiSelect: one selected, its name, count 1, pinned in Selected, a clear link", () => {
  const html = render(["gamma"]);
  assert.match(html, /^<div class="ms has-value">/);
  assert.match(html, /<span class="ms-values">gamma<\/span><span class="ms-count" title="gamma">1<\/span>/);
  assert.doesNotMatch(html, /ms-more/);
  assert.deepEqual(groups(html), ["Selected · 1", "web · 2"]);
  assert.deepEqual(rows(html), [
    ["gamma", true],
    ["alpha", false],
    ["beta", false],
    ["solo", false],
  ]);
  assert.match(html, /class="ms-option checked "><span class="ms-box" aria-hidden="true"><svg/);
  assert.match(html, /<a href="\/" class="ms-clear" aria-label="Clear agent filter">×<\/a><\/div>$/);
});

test("MultiSelect: several selected, the server shows one name and +N, the count holds all", () => {
  const html = render(["alpha", "beta", "solo"]);
  assert.match(html, /<span class="ms-values">alpha<\/span><span class="ms-more">\+2<\/span>/);
  assert.match(html, /<span class="ms-count" title="alpha, beta, solo">3<\/span>/);
  assert.match(html, /<span>3 of 4 selected<\/span>/);
  assert.deepEqual(groups(html), ["Selected · 3", "core · 1"]);
});

test("MultiSelect: no options, the empty line names the noun", () => {
  const html = render([], []);
  assert.match(html, /<div class="ms-empty">No agents match\.<\/div>/);
  assert.deepEqual(rows(html), []);
});
