import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogFacts } from "../../components/LogFacts";

const SHA = "3f2a9c1be04d7e6658a1c0f2b9d34e7a51c8f60d2e9b7a4c13f5e8d0a6b2c9e1";

test("LogFacts: an ended run shows the size in binary units, its exact bytes in the title", () => {
  const html = renderToStaticMarkup(<LogFacts logBytes={3_276_800} logSha256={SHA} logTruncated={false} />);
  assert.match(html, /<dt>log size<\/dt><dd class="num kv-inline"><span title="3,276,800 bytes">3.1 MiB<\/span><\/dd>/);
});

test("LogFacts: the sha256 is shortened on screen, whole in the title and the Copy button", () => {
  const html = renderToStaticMarkup(<LogFacts logBytes={812} logSha256={SHA} logTruncated={false} />);
  assert.match(html, new RegExp(`<span title="${SHA}">${SHA.slice(0, 12)}…</span>`));
  assert.match(html, /<button type="button" class="copy-btn ">Copy<\/button>/);
});

test("LogFacts: a log stopped at its cap carries the amber truncated badge", () => {
  const html = renderToStaticMarkup(<LogFacts logBytes={52_428_800} logSha256={SHA} logTruncated />);
  assert.match(
    html,
    /<span class="badge attention" title="The log reached claude.max_log_bytes[^"]*">truncated<\/span>/,
  );
});

test("LogFacts: no badge when the log is whole", () => {
  const html = renderToStaticMarkup(<LogFacts logBytes={812} logSha256={SHA} logTruncated={false} />);
  assert.doesNotMatch(html, /truncated<\/span>/);
});

test("LogFacts: a running run or an older row shows dashes and no Copy button", () => {
  const html = renderToStaticMarkup(<LogFacts logBytes={null} logSha256={null} logTruncated={null} />);
  assert.match(html, /<dd class="num kv-inline"><span>–<\/span><\/dd>/);
  assert.match(html, /<dt>log sha256<\/dt><dd class="mono kv-inline">–<\/dd>/);
  assert.doesNotMatch(html, /copy-btn/);
});
