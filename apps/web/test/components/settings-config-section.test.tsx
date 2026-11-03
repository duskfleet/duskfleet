import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigSection } from "../../components/Settings";
import { SECTIONS } from "../../lib/settings";

function render(configPath: string): string {
  const def = SECTIONS.find((s) => s.id === "concurrency")!;
  return renderToStaticMarkup(
    <ConfigSection
      id={def.id}
      values={Object.fromEntries(def.fields.map((f) => [f.key, f.default]))}
      agents={[]}
      schedulerEnabled={true}
      configPath={configPath}
    />,
  );
}

test("ConfigSection: the save dialog names the duskfleet.yaml it writes, as given (home-shortened)", () => {
  const html = render("~/.config/duskfleet/duskfleet.yaml");
  assert.match(html, /Written to <code>~\/\.config\/duskfleet\/duskfleet\.yaml<\/code>\./);
});

test("ConfigSection: in a checkout the dialog names the repo's config file", () => {
  const html = render("/srv/duskfleet/config/duskfleet.yaml");
  assert.match(html, /Written to <code>\/srv\/duskfleet\/config\/duskfleet\.yaml<\/code>\./);
});

test("ConfigSection: with nothing changed, Save is disabled and the footer says so", () => {
  const html = render("~/.config/duskfleet/duskfleet.yaml");
  assert.match(html, /No unsaved changes/);
  assert.match(html, /<button type="button" class="btn primary" disabled="">Save concurrency…<\/button>/);
});
