import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentStatus } from "../../components/AgentStatus";
import { Spark } from "../../components/Spark";
import { StatusBadge } from "../../components/StatusBadge";

test("AgentStatus: one pill per state, its tint class and its title", () => {
  assert.equal(
    renderToStaticMarkup(<AgentStatus state="running" />),
    '<span class="badge running" title="A run of this agent is in progress">running</span>',
  );
  const paused = renderToStaticMarkup(<AgentStatus state="paused" />);
  assert.match(paused, /^<span class="badge paused-auto" title="A schedule of this agent was paused by the scheduler/);
  assert.match(paused, />paused · auto<\/span>$/);
  assert.equal(
    renderToStaticMarkup(<AgentStatus state="review" />),
    '<span class="badge attention" title="The last finished run needs review (its stored review reasons)">needs review</span>',
  );
  assert.equal(
    renderToStaticMarkup(<AgentStatus state="idle" />),
    '<span class="badge pending" title="No run in progress; the last finished run is clean">idle</span>',
  );
});

test("StatusBadge: a clean completed run is green, its status alone in the title", () => {
  assert.equal(
    renderToStaticMarkup(<StatusBadge run={{ status: "completed", reviewReasons: [] }} />),
    '<span class="badge completed" title="completed">completed</span>',
  );
});

test("StatusBadge: a completed run with a review reason is amber needs review, the reasons in the title", () => {
  assert.equal(
    renderToStaticMarkup(
      <StatusBadge run={{ status: "completed", reviewReasons: ["permission_denied", "empty_run"] }} />,
    ),
    '<span class="badge attention" title="completed · needs review: permission denied · no work done">needs review</span>',
  );
});

test("StatusBadge: a failed or timed-out run keeps its own colour, the reasons go in the title", () => {
  assert.equal(
    renderToStaticMarkup(<StatusBadge run={{ status: "timed_out", reviewReasons: ["timed_out"] }} />),
    '<span class="badge timed_out" title="timed out · needs review: timed out">timed out</span>',
  );
  assert.equal(
    renderToStaticMarkup(<StatusBadge status="failed" reasons={["failed", "nonzero_exit"]} />),
    '<span class="badge failed" title="failed · needs review: failed · non-zero exit code">failed</span>',
  );
});

test("StatusBadge: running and cancelled carry no verdict; no status at all is pending", () => {
  assert.equal(
    renderToStaticMarkup(<StatusBadge status="running" />),
    '<span class="badge running" title="running">running</span>',
  );
  assert.equal(
    renderToStaticMarkup(<StatusBadge status="cancelled" />),
    '<span class="badge cancelled" title="cancelled">cancelled</span>',
  );
  assert.equal(renderToStaticMarkup(<StatusBadge />), '<span class="badge pending" title="pending">pending</span>');
});

test("Spark: bar heights proportional to the day's value, 26 px max, 2 px floor; decorative", () => {
  const html = renderToStaticMarkup(<Spark values={[0, 1, 4]} />);
  assert.equal(
    html,
    '<span class="spark " aria-hidden="true">' +
      '<span class="spark-bar " style="height:2px"></span>' +
      '<span class="spark-bar " style="height:7px"></span>' +
      '<span class="spark-bar today " style="height:26px"></span>' +
      "</span>",
  );
});

test("Spark: all-zero days are flat 2 px bars", () => {
  const html = renderToStaticMarkup(<Spark values={[0, 0]} />);
  assert.equal((html.match(/height:2px/g) ?? []).length, 2);
  assert.doesNotMatch(html, /height:(?!2px)/);
});

test("Spark: today's bar takes live or accent, small is its own class", () => {
  assert.match(renderToStaticMarkup(<Spark values={[1, 2]} today="live" />), /class="spark-bar today live"/);
  const accent = renderToStaticMarkup(<Spark values={[1, 2]} today="accent" small />);
  assert.match(accent, /^<span class="spark small"/);
  assert.match(accent, /class="spark-bar today accent"/);
});
