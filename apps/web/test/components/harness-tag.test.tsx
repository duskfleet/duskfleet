import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessTag } from "../../components/HarnessTag";
import { harnessInfo } from "../../lib/harness";

const host = new Map<string, string | null>([
  ["claude", null],
  ["copilot", "GitHub Copilot CLI not found"],
]);

test("HarnessTag: the default harness, muted text", () => {
  assert.equal(
    renderToStaticMarkup(<HarnessTag info={harnessInfo(undefined, host)} />),
    '<span class="harness" title="Runs on the claude agent CLI (harness)">claude</span>',
  );
});

test("HarnessTag: another harness this host has, as the file spells it", () => {
  const html = renderToStaticMarkup(<HarnessTag info={harnessInfo("copilot", new Map([["copilot", null]]))} />);
  assert.equal(html, '<span class="harness" title="Runs on the copilot agent CLI (harness)">copilot</span>');
});

test("HarnessTag: a shipped harness whose CLI is missing, amber, not installed, the reason on hover", () => {
  assert.equal(
    renderToStaticMarkup(<HarnessTag info={harnessInfo("copilot", host)} />),
    '<span class="harness warn-text" title="GitHub Copilot CLI not found; set copilot.binary in duskfleet.yaml or put it on PATH: its runs are refused">copilot · not installed</span>',
  );
});

test("HarnessTag: a harness no adapter exists for, amber, not registered", () => {
  assert.equal(
    renderToStaticMarkup(<HarnessTag info={harnessInfo("codex", host)} />),
    '<span class="harness warn-text" title="harness codex is not registered: its runs are refused">codex · not registered</span>',
  );
});
