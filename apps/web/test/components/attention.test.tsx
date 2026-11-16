import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttentionEmpty,
  AttentionSections,
  AttentionSeen,
  AttentionSummary,
  KindChip,
} from "../../components/Attention";
import { AttentionBadge } from "../../components/AttentionBadge";
import {
  MarkSeenButtonView,
  markedText,
  SeenGroupView,
  SeenToastView,
  SeenToggleView,
} from "../../components/SeenControls";
import type { AttentionSection } from "../../lib/attention";

const NOW = Date.parse("2026-11-05T22:45:00Z");
const AT = "2026-11-05T22:12:00Z";

const login: AttentionSection = {
  kind: "login",
  title: "Login and quota errors",
  items: [
    {
      kind: "login",
      key: "login:auth_required",
      subjectId: "auth_required",
      eventId: "r1",
      dismissable: false,
      label: "claude CLI · login error",
      tone: "bad",
      code: "auth_required",
      badge: "Login error",
      title: "claude CLI · 3 agents",
      detail: "Not logged in: 3 runs failed with auth_required (a, b, c)",
      agents: ["a", "b", "c"],
      runs: 3,
      runId: "r1",
      at: AT,
      fix: "run claude and log in",
    },
  ],
};
const failed: AttentionSection = {
  kind: "failed",
  title: "Failed runs",
  items: [
    {
      kind: "failed",
      key: "failed:dev",
      subjectId: "dev",
      eventId: "r9",
      dismissable: true,
      label: "dev · timed out",
      tone: "bad",
      badge: "Timed out ×5",
      agentId: "dev",
      project: "duskfleet",
      detail: "Timed out after 30 min, 14 tool calls",
      model: "claude-sonnet-4-20250514",
      durationMs: 30 * 60_000,
      runId: "r9",
      count: 5,
      at: AT,
    },
  ],
};
const review: AttentionSection = {
  kind: "review",
  title: "Needs review",
  items: [{ ...failed.items[0], kind: "review", key: "review:dev", tone: "warn", badge: "Needs review" } as never],
};
const schedules: AttentionSection = {
  kind: "schedules",
  title: "Schedules paused or in error",
  items: [
    {
      kind: "schedules",
      key: "schedule:s1",
      subjectId: "s1",
      eventId: "77",
      dismissable: true,
      label: "nightly · auto-paused",
      tone: "warn",
      badge: "Auto-paused",
      scheduleId: "s1",
      name: "nightly",
      agentId: "dev",
      detail: "The last 3 ended runs were empty",
      at: AT,
      nextAt: null,
    },
  ],
};
const budgets: AttentionSection = {
  kind: "budgets",
  title: "Budget warnings",
  items: [
    {
      kind: "budgets",
      key: "budget:b1",
      subjectId: "b1",
      eventId: "2026-11:warn",
      dismissable: true,
      label: "global · November · budget 85 %",
      tone: "warn",
      badge: "Budget 85 %",
      title: "global · November",
      detail: "$42.50 of $50.00 spent",
      countedUsd: 42.5,
      amountUsd: 50,
    },
  ],
};
const busy: AttentionSection = {
  kind: "busy",
  title: "Repeated skipped busy",
  items: [
    {
      kind: "busy",
      key: "busy:s2",
      subjectId: "s2",
      eventId: "9",
      dismissable: true,
      label: "ui-dev · skipped busy ×6",
      tone: "neutral",
      badge: "Skipped busy ×6",
      scheduleId: "s2",
      name: "ui-dev",
      agentId: "ui",
      streak: 6,
      detail: "6 fires in a row skipped",
      at: AT,
    },
  ],
};

test("AttentionBadge: the count with its tone, a spoken label, nothing at 0 or without data", () => {
  const warn = renderToStaticMarkup(<AttentionBadge badge={{ count: 12, tone: "warn" }} />);
  assert.match(warn, /^<span class="nav-badge warn" title="12 items need you">/);
  assert.match(warn, /<span aria-hidden="true">12<\/span><span class="sr-only">12 items need you<\/span>/);
  const bad = renderToStaticMarkup(<AttentionBadge badge={{ count: 1, tone: "bad" }} />);
  assert.match(bad, /class="nav-badge bad" title="1 item needs you"/);
  assert.match(renderToStaticMarkup(<AttentionBadge badge={{ count: 140, tone: "warn" }} />), />99\+</);
  assert.equal(renderToStaticMarkup(<AttentionBadge badge={null} />), "");
  assert.equal(renderToStaticMarkup(<AttentionBadge badge={{ count: 0, tone: "warn" }} />), "");
});

test("KindChip: tone class on the chip", () => {
  assert.equal(renderToStaticMarkup(<KindChip tone="neutral">x</KindChip>), '<span class="att-chip neutral">x</span>');
});

test("AttentionSummary: one chip per section with its tone; nothing when empty", () => {
  const html = renderToStaticMarkup(<AttentionSummary sections={[login, failed, busy]} />);
  assert.match(html, /<span class="att-chip bad">1 login error<\/span>/);
  assert.match(html, /<span class="att-chip bad">1 failed run<\/span>/);
  assert.match(html, /<span class="att-chip neutral">1 skipped busy<\/span>/);
  assert.equal(renderToStaticMarkup(<AttentionSummary sections={[]} />), "");
});

test("login section: tinted row, runs count, How to fix opens a fix row in place (no link)", () => {
  const html = renderToStaticMarkup(<AttentionSections sections={[login]} now={NOW} />);
  assert.match(html, /<h2 id="att-login" class="att-h2">Login and quota errors <span class="count">1<\/span>/);
  assert.match(html, /<tr class="att-row tint-bad">/);
  assert.match(html, /<span class="att-chip bad">Login error<\/span>/);
  assert.match(html, />3 runs</);
  assert.match(
    html,
    /<details class="att-fix"><summary aria-controls="fix-auth_required">How to fix →<\/summary><\/details>/,
  );
  assert.match(html, /<tr class="att-fix-row" id="fix-auth_required"><td colspan="6">.*run claude and log in/i);
  assert.doesNotMatch(html, /href=/);
  // cannot be marked seen: the heading note, no toggle (not even a disabled one), no section button
  assert.match(html, /<span class="att-head-note">Cannot be marked seen: leaves when fixed<\/span>/);
  assert.match(html, /<td class="c-seen"><\/td>/);
  assert.doesNotMatch(html, /<button/);
});

test("failed and review sections: the 1280 columns, the run link, model and duration", () => {
  const html = renderToStaticMarkup(<AttentionSections sections={[failed, review]} now={NOW} />);
  for (const th of ["Status", "Run", "Model", "Duration", "When"]) assert.match(html, new RegExp(`>${th}</th>`));
  assert.match(html, /<span class="att-chip bad">Timed out ×5<\/span>/);
  assert.match(html, /<span class="att-chip warn">Needs review<\/span>/);
  assert.match(html, /<div class="att-title">dev · duskfleet<\/div>/);
  assert.match(html, />sonnet 4</);
  assert.match(html, />30 min</);
  assert.match(html, /<a href="\/runs\/r9" class="att-link">Open run →<\/a>/);
  // fixed order kept as given
  assert.ok(html.indexOf("att-failed") < html.indexOf("att-review"));
});

test("schedules, budgets and busy: anchors on /schedules, Costs, and the next-fire note for 390", () => {
  const html = renderToStaticMarkup(<AttentionSections sections={[schedules, budgets, busy]} now={NOW} />);
  assert.match(html, />Next fire if resumed<\/th>/);
  assert.match(html, /<span class="att-narrow"> Next fire if resumed: –<\/span>/);
  assert.match(html, /<a href="\/schedules#s1" class="att-link">Open schedule →<\/a>/);
  assert.match(html, /<a href="\/costs" class="att-link">Open Costs →<\/a>/);
  assert.match(html, />\$42\.50 \/ \$50\.00</);
  assert.match(html, /<span class="att-chip neutral">Skipped busy ×6<\/span>/);
  assert.match(html, /<a href="\/schedules#s2" class="att-link">Open schedule →<\/a>/);
});

test("seen toggle per dismissable row, Mark section seen on the heading, no cannot-see note", () => {
  const html = renderToStaticMarkup(<AttentionSections sections={[failed]} now={NOW} />);
  assert.match(
    html,
    /<button type="button" class="att-seen" aria-pressed="false" aria-label="Mark seen: dev · timed out">/,
  );
  assert.match(
    html,
    /<button type="button" class="att-mark">.*<span class="att-wide">Mark section seen<\/span><span class="att-short">Mark seen<\/span><\/button>/,
  );
  assert.doesNotMatch(html, /att-head-note/);
  assert.doesNotMatch(html, /att-new/);
});

test("came back: the New since seen pill with the older seen time", () => {
  const back = { ...failed, items: [{ ...failed.items[0], newSinceSeen: "2026-11-05T20:40:00Z" }] } as AttentionSection;
  const html = renderToStaticMarkup(<AttentionSections sections={[back]} now={NOW} />);
  assert.match(
    html,
    /<span class="att-new"><span class="att-new-dot" aria-hidden="true"><\/span>New since seen<span class="att-new-time"> /,
  );
});

test("AttentionSummary: the neutral n seen chip after the kinds; only it when all are seen", () => {
  assert.match(
    renderToStaticMarkup(<AttentionSummary sections={[failed]} seen={5} />),
    /1 failed run<\/span><span class="att-chip neutral">5 seen<\/span>/,
  );
  assert.equal(
    renderToStaticMarkup(<AttentionSummary sections={[]} seen={11} />),
    '<div class="att-summary"><span class="att-chip neutral">11 seen</span></div>',
  );
});

test("AttentionSeen: an open disclosure of muted rows, seen time, link and the pressed toggle", () => {
  const seenAt = new Date(NOW - 30 * 60_000).toISOString();
  const items = [
    { ...failed.items[0], seenAt },
    { ...budgets.items[0], seenAt: new Date(NOW - 10_000).toISOString() },
  ] as never;
  const html = renderToStaticMarkup(<AttentionSeen items={items} now={NOW} open={true} />);
  assert.match(
    html,
    /<button type="button" class="att-disclosure" aria-expanded="true" aria-controls="att-seen-body">/,
  );
  assert.match(html, /Seen <span class="count">2<\/span>/);
  assert.match(html, />Kind<\/th>.*>Item<\/th>.*>Seen<\/th>/);
  assert.match(html, /<tr class="att-row att-seen-row">/);
  assert.match(html, /<td class="c-when">seen \S+/);
  assert.match(html, /<td class="c-when">seen just now<\/td>/);
  assert.match(html, /<a href="\/runs\/r9" class="att-link">Open run →<\/a>/);
  assert.match(html, /aria-pressed="true" aria-label="Mark unseen: dev · timed out"/);
  assert.doesNotMatch(html, /att-show/);
  assert.doesNotMatch(html, / hidden=""/);
  assert.equal(renderToStaticMarkup(<AttentionSeen items={[]} now={NOW} open={true} />), "");
});

test("SeenGroupView collapsed: aria-expanded false, Show, body hidden", () => {
  const html = renderToStaticMarkup(
    <SeenGroupView count={11} open={false} onToggle={() => {}}>
      <p>rows</p>
    </SeenGroupView>,
  );
  assert.match(html, /<section class="att-section att-seen-group" aria-labelledby="att-seen">/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /<span class="att-show">Show<\/span>/);
  assert.match(html, /<div id="att-seen-body" hidden="">/);
});

test("SeenToggleView, MarkSeenButtonView: pending disables; no short label when none given", () => {
  assert.match(
    renderToStaticMarkup(<SeenToggleView label="x" pressed={false} pending={true} onClick={() => {}} />),
    /aria-label="Mark seen: x" disabled=""/,
  );
  const all = renderToStaticMarkup(<MarkSeenButtonView label="Mark all seen" pending={false} onClick={() => {}} />);
  assert.match(all, /<\/svg>Mark all seen<\/button>$/);
  assert.doesNotMatch(all, /att-short/);
});

test("SeenToastView: role=status always present; text and Undo when shown", () => {
  assert.equal(
    renderToStaticMarkup(<SeenToastView text={null} pending={false} onUndo={() => {}} />),
    '<div class="att-toast-host" role="status"></div>',
  );
  const html = renderToStaticMarkup(
    <SeenToastView text={markedText(1, "df-planner · timed out")} pending={false} onUndo={() => {}} />,
  );
  assert.match(html, /<span class="att-toast-text">Marked seen: df-planner · timed out<\/span>/);
  assert.match(html, /<button type="button" class="att-undo">Undo<\/button>/);
  assert.equal(markedText(4), "Marked 4 seen");
});

test("AttentionEmpty with seen items: All n items are seen and what brings one back", () => {
  const html = renderToStaticMarkup(<AttentionEmpty now={NOW} total={11} />);
  assert.match(html, /<p class="att-empty-title">All 11 items are seen<\/p>/);
  assert.match(html, /comes back here by itself when something new happens/);
  assert.doesNotMatch(html, /Nothing needs you/);
});

test("AttentionEmpty: Nothing needs you, ok dot, link to recent runs", () => {
  const html = renderToStaticMarkup(<AttentionEmpty now={NOW} />);
  assert.match(html, /<span class="att-ok-dot" aria-hidden="true"><\/span>Nothing needs you/);
  assert.match(html, /<a href="\/" class="att-link">Recent runs →<\/a>/);
});
