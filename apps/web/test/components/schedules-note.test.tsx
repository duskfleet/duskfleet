import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SchedulesNote } from "../../components/SchedulesNote";

test("SchedulesNote: create is MCP only, edits on the dashboard, the CLI only fires (no 'or the CLI' for create)", () => {
  const html = renderToStaticMarkup(<SchedulesNote runNowCmd="npm run cli -- schedules run-now <id or name>" />);
  assert.match(html, /^<span class="note">Created over MCP \(<code>create_schedule<\/code>\)\. /);
  assert.match(html, /Pause, resume, cron and time zone, delete and run now here;/);
  assert.match(html, /CLI fires one with <code>npm run cli -- schedules run-now &lt;id or name&gt;<\/code>\.<\/span>$/);
  assert.doesNotMatch(html, /or the CLI/);
});
