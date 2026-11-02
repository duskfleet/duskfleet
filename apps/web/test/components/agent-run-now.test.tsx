import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRunNow, AgentRunNowView } from "../../components/AgentRunNow";

const noop = () => {};
const nightly = { id: "s1", name: "nightly", requested: false };
const hourly = { id: "s2", name: "hourly", requested: false };

function view(props: Partial<Parameters<typeof AgentRunNowView>[0]>): string {
  return renderToStaticMarkup(
    <AgentRunNowView
      schedules={[nightly]}
      open={false}
      pending={false}
      result={null}
      onOpen={noop}
      onCancel={noop}
      onFire={noop}
      {...props}
    />,
  );
}

/** Each <button>: its text and whether it is disabled. */
function buttons(html: string): Array<[string, boolean]> {
  return [...html.matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], m[1].includes("disabled")]);
}

test("AgentRunNow: without a bound schedule it renders nothing", () => {
  assert.equal(renderToStaticMarkup(<AgentRunNow schedules={[]} />), "");
});

test("AgentRunNow: closed, one primary Run now… button that explains the busy rules", () => {
  const html = renderToStaticMarkup(<AgentRunNow schedules={[nightly, hourly]} />);
  assert.equal(
    html,
    '<span class="ad-run-now"><button type="button" class="ad-btn primary" ' +
      'title="Fire a bound schedule once now, outside its cron: same busy rules as a tick">Run now…</button></span>',
  );
  assert.equal(view({ open: false }), html);
});

test("AgentRunNow: open, one button per bound schedule named in quotes, then Cancel", () => {
  const html = view({ open: true, schedules: [nightly, hourly] });
  assert.match(html, /^<span class="ad-run-now"><span class="muted">Run now through<\/span>/);
  assert.deepEqual(buttons(html), [
    ["“nightly”", false],
    ["“hourly”", false],
    ["Cancel", false],
  ]);
  assert.equal((html.match(/class="ad-btn primary"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /title=/);
});

test("AgentRunNow: open with one schedule already requested, that one is disabled and says why", () => {
  const html = view({ open: true, schedules: [{ ...nightly, requested: true }, hourly] });
  assert.deepEqual(buttons(html), [
    ["“nightly”", true],
    ["“hourly”", false],
    ["Cancel", false],
  ]);
  assert.match(html, /disabled="" title="Already requested: the ticking process starts it on its next tick">“nightly”/);
});

test("AgentRunNow: open with every schedule requested, only Cancel stays enabled", () => {
  const html = view({
    open: true,
    schedules: [
      { ...nightly, requested: true },
      { ...hourly, requested: true },
    ],
  });
  assert.deepEqual(buttons(html), [
    ["“nightly”", true],
    ["“hourly”", true],
    ["Cancel", false],
  ]);
});

test("AgentRunNow: while the request is pending every button is disabled and shows …", () => {
  assert.deepEqual(buttons(view({ open: true, pending: true, schedules: [nightly, hourly] })), [
    ["…", true],
    ["…", true],
    ["Cancel", true],
  ]);
});

test("AgentRunNow: the result in place, muted when it worked, bad-text when it did not", () => {
  const ok = view({ result: { ok: true, message: "Run requested for nightly" } });
  assert.match(ok, /Run now…<\/button><span class="muted">Run requested for nightly<\/span><\/span>$/);
  const err = view({ result: { ok: false, message: "schedule not found" } });
  assert.match(err, /Run now…<\/button><span class="bad-text">schedule not found<\/span><\/span>$/);
});
