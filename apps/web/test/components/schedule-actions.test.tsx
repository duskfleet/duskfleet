import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleActions, ScheduleActionsView } from "../../components/ScheduleActions";

const noop = () => {};
const on = {
  mode: noop,
  draftCron: noop,
  draftTz: noop,
  cancelEdit: noop,
  save: noop,
  runNow: noop,
  toggleEnabled: noop,
  remove: noop,
};
const base = {
  name: "nightly",
  enabled: true,
  cron: "0 3 * * *",
  timeZone: "Europe/London",
  runRequested: false,
};

function view(props: Partial<Parameters<typeof ScheduleActionsView>[0]>): string {
  return renderToStaticMarkup(
    <ScheduleActionsView
      {...base}
      mode="idle"
      draftCron={base.cron}
      draftTz={base.timeZone}
      pending={false}
      result={null}
      on={on}
      {...props}
    />,
  );
}

/** Each <button>: its text and whether it is disabled. */
function buttons(html: string): Array<[string, boolean]> {
  return [...html.matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], m[1].includes("disabled")]);
}

test("ScheduleActions: idle and enabled, Run now / Pause / Edit when / Delete, all enabled", () => {
  const html = renderToStaticMarkup(<ScheduleActions id="s1" {...base} />);
  assert.match(html, /^<span class="sched-actions">/);
  assert.deepEqual(buttons(html), [
    ["Run now", false],
    ["Pause", false],
    ["Edit when", false],
    ["Delete", false],
  ]);
  assert.match(html, /title="Fire once now, outside the cron and even when paused\./);
  assert.match(html, /title="Pause: nothing fires until resumed">Pause</);
  assert.match(html, /class="copy-btn danger" title="Remove the schedule; past runs are kept">Delete</);
  assert.equal(view({}), html);
});

test("ScheduleActions: paused, the toggle says Resume", () => {
  const html = renderToStaticMarkup(<ScheduleActions id="s1" {...base} enabled={false} />);
  assert.match(html, /title="Resume: the next tick is computed from now">Resume</);
  assert.doesNotMatch(html, />Pause</);
});

test("ScheduleActions: a run already requested, Run requested is disabled and says why", () => {
  const html = renderToStaticMarkup(<ScheduleActions id="s1" {...base} runRequested />);
  assert.deepEqual(buttons(html)[0], ["Run requested", true]);
  assert.match(html, /title="Already requested: the ticking process starts it on its next tick">Run requested</);
});

test("ScheduleActions: pending, every button disabled; the action buttons show …", () => {
  assert.deepEqual(buttons(view({ pending: true })), [
    ["…", true],
    ["…", true],
    ["Edit when", true],
    ["Delete", true],
  ]);
});

test("ScheduleActions: confirm delete names the schedule, Yes, delete is the danger button", () => {
  const html = view({ mode: "confirm-delete" });
  assert.match(html, /^<span class="sched-actions"><span class="muted">Delete &quot;nightly&quot;\?<\/span>/);
  assert.deepEqual(buttons(html), [
    ["Yes, delete", false],
    ["Cancel", false],
  ]);
  assert.match(html, /class="copy-btn danger">Yes, delete</);
  assert.deepEqual(buttons(view({ mode: "confirm-delete", pending: true })), [
    ["…", true],
    ["Cancel", true],
  ]);
});

test("ScheduleActions: the result in place, muted when it worked, err when it did not", () => {
  assert.match(view({ result: { ok: true, message: "Paused" } }), /<span class="muted">Paused<\/span><\/span>$/);
  assert.match(view({ result: { ok: false, message: "busy" } }), /<span class="err">busy<\/span><\/span>$/);
});

test("ScheduleActions: edit, cron and time zone fields with the zone list; Save disabled until a change", () => {
  const html = view({ mode: "edit" });
  assert.match(html, /^<form class="sched-edit">/);
  assert.match(
    html,
    /<span class="l">cron<\/span><input class="mono" placeholder="0 8-20 \* \* 1-5" spellCheck="false"[^>]* value="0 3 \* \* \*"\/>/,
  );
  assert.match(
    html,
    /<input class="mono" placeholder="Europe\/London" spellCheck="false" list="duskfleet-timezones" value="Europe\/London"\/>/,
  );
  assert.match(html, /<datalist id="duskfleet-timezones"><option value="Europe\/London"><\/option>/);
  assert.deepEqual(buttons(html), [
    ["Save", true],
    ["Cancel", false],
  ]);
  assert.match(html, /<span class="hint">5 fields: minute hour day-of-month month day-of-week\./);
});

test("ScheduleActions: edit with a changed draft enables Save; an error shows, a success does not", () => {
  assert.deepEqual(buttons(view({ mode: "edit", draftCron: "0 4 * * *" }))[0], ["Save", false]);
  assert.deepEqual(buttons(view({ mode: "edit", draftTz: "UTC" }))[0], ["Save", false]);
  assert.deepEqual(buttons(view({ mode: "edit", draftCron: " 0 3 * * * " }))[0], ["Save", true]);
  assert.deepEqual(buttons(view({ mode: "edit", draftCron: "x", pending: true })), [
    ["…", true],
    ["Cancel", true],
  ]);
  assert.match(
    view({ mode: "edit", result: { ok: false, message: "bad cron" } }),
    /<span class="err">bad cron<\/span>/,
  );
  assert.doesNotMatch(view({ mode: "edit", result: { ok: true, message: "Saved" } }), /Saved/);
});
