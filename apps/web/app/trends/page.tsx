import { REVIEW_REASON_LABELS, type ReviewReason, TREND_RANGES, type TrendRange } from "@duskfleet/core";
import Link from "next/link";
import { AgentTable, type AgentTableRow } from "@/components/charts/AgentTable";
import { LineChart, type LineSeries } from "@/components/charts/LineChart";
import { ChartLegend, StackedBars } from "@/components/charts/StackedBars";
import { agentRecentReviewReasons, listAgents, listProjects, trends, trendsForAgents } from "@/lib/data";
import { fmtInt, fmtPct } from "@/lib/format";
import {
  agentRows,
  bucketLabel,
  cleanRate,
  countAxis,
  dayLabel,
  defaultSelection,
  deltaText,
  granularityText,
  MAX_DRAWN_LINES,
  MAX_TICKED,
  percentAxis,
  pointIndexes,
  RANGE_LABELS,
  RANGE_PHRASES,
  unitCount,
  unitName,
  worseningAgent,
  xTickIndexes,
} from "@/lib/trends";

export const dynamic = "force-dynamic";

type Param = string | string[] | undefined;
type Search = { agent?: Param; project?: Param; range?: Param; q?: Param; all?: Param };
type Next = { agent?: string[]; project?: string; range?: string; outcome?: string; reason?: string; q?: string };

const isRange = (v: string | undefined): v is TrendRange => (TREND_RANGES as readonly string[]).includes(v ?? "");
/** A repeated param (`?agent=a&agent=b`) as a list, as on the Runs page. */
const many = (v: Param): string[] => [...new Set((Array.isArray(v) ? v : [v]).filter(Boolean))] as string[];
const one = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const parts = ["Clean-run trend", one(sp.project), many(sp.agent).join(", ")].filter(Boolean);
  return { title: `${parts.join(" · ")} · Duskfleet` };
}

const LINE_HEIGHT = 232;
const BAR_HEIGHT = 200;

export default async function TrendsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const rangeParam = one(sp.range);
  const range: TrendRange = isRange(rangeParam) ? rangeParam : "1m";
  const agents = listAgents();
  const projects = listProjects();
  const projectParam = one(sp.project);
  const project = projectParam ? projects.find((p) => p.id === projectParam) : undefined;
  const q = one(sp.q)?.trim() ?? "";
  const now = new Date();
  // Every agent of the scope: the table lists them all whatever is ticked.
  const full = trends(range, { projectPath: project?.path });
  // Unknown ids are dropped, as on the Runs page, rather than showing an empty chart. More than
  // MAX_TICKED is cut: the chart never draws more.
  const picked = many(sp.agent)
    .filter((id) => agents.some((a) => a.id === id) || full.byAgent.some((a) => a.agentId === id))
    .slice(0, MAX_TICKED);
  // One agent keeps the old meaning: the whole page filtered to it. Several are ticks in the
  // table, and the other two charts follow the same set, as the Runs filters do.
  const agent = picked.length === 1 ? picked[0] : undefined;
  const s = agent ? trends(range, { agentId: agent, projectPath: project?.path }) : full;
  const scoped = picked.length > 1 ? trendsForAgents(range, picked, project?.path) : s;
  const unit = unitName(s.bucket);

  const qs = (base: string, next: Next) => {
    const p = new URLSearchParams();
    const merged: Next = { agent: picked, project: project?.id, ...next };
    for (const k of ["agent", "project", "range", "outcome", "reason", "q"] as const) {
      const v = merged[k];
      for (const x of Array.isArray(v) ? v : [v]) if (x) p.append(k, x);
    }
    const query = p.toString();
    return query ? `${base}?${query}` : base;
  };
  const trendHref = (next: Next) => qs("/trends", { range: range === "1m" ? undefined : range, ...next });
  const runsHref = (extra: Next = {}) => qs("/", extra);

  const kept = [
    picked.length
      ? {
          key: "agent",
          label: `agent${picked.length > 1 ? "s" : ""}: ${picked.join(", ")}`,
          href: trendHref({ agent: [] }),
        }
      : null,
    project ? { key: "project", label: `project: ${project.id}`, href: trendHref({ project: undefined }) } : null,
  ].filter((k): k is { key: string; label: string; href: string } => k !== null);

  const header = (
    <>
      <div className="page-head">
        <h1>Clean-run trend</h1>
        <Link href={runsHref()} className="back-link">
          ← back to Runs
        </Link>
      </div>
      <div className="trend-toolbar">
        <nav className="period" aria-label="Period">
          {TREND_RANGES.map((r) => (
            <Link
              key={r}
              href={trendHref({ range: r === "1m" ? undefined : r })}
              className={r === range ? "on" : ""}
              aria-current={r === range ? "true" : undefined}
            >
              {RANGE_LABELS[r]}
            </Link>
          ))}
        </nav>
        <span className="granularity">{granularityText(s.bucket, s.starts.length, now)}</span>
        {kept.length > 0 && (
          <span className="kept">
            opened with
            {kept.map((k) => (
              <Link
                key={k.key}
                href={k.href}
                className="kept-chip"
                title="Remove this filter"
                aria-label={`${k.label}, remove this filter`}
              >
                {k.label} <span aria-hidden="true">✕</span>
              </Link>
            ))}
          </span>
        )}
      </div>
    </>
  );

  if (s.totals.finished === 0) {
    return (
      <>
        {header}
        <section className="card trend-panel">
          <h2 className="panel-title">Clean rate by agent</h2>
          <div className="trend-empty">
            <strong>No finished runs in {RANGE_PHRASES[range]}</strong>
            <span>Runs appear here once they end.{range !== "1y" && " Try a longer period."}</span>
            {range !== "1y" && (
              <Link href={trendHref({ range: "1y" })} className="btn">
                Show 1 year
              </Link>
            )}
          </div>
        </section>
        <p className="trend-note">{NOTE}</p>
      </>
    );
  }

  // ---- clean rate by agent ----
  const overallRates = s.overall.map(cleanRate);
  const agentRates = s.byAgent.map((a) => ({ agentId: a.agentId, rates: a.counts.map(cleanRate) }));
  const multi = agentRates.length > 1;
  const worst = multi ? worseningAgent(agentRates) : null;
  const rows = agentRows(s.byAgent);
  // With MAX_DRAWN_LINES agents or fewer everything is drawn, as before DS-23, unless several
  // agents are ticked in the URL (the other panels follow that set, so the chart does too);
  // above, the ticks: the URL's set, else the most-worsening and the 4 lowest.
  const fewAgents = agentRates.length <= MAX_DRAWN_LINES;
  const selectable = !agent && (!fewAgents || picked.length > 1);
  const drawn = new Set(
    !multi
      ? []
      : !selectable
        ? agentRates.map((a) => a.agentId)
        : picked.length
          ? picked
          : defaultSelection(rows, worst?.agentId ?? null),
  );
  const last = (rates: ReadonlyArray<number | null>) => {
    const i = pointIndexes(rates).at(-1);
    return i === undefined ? "" : `${Math.round(rates[i] as number)}%`;
  };
  const series: LineSeries[] = [
    ...(multi
      ? agentRates.map((a) => ({
          id: a.agentId,
          values: a.rates,
          tone: a.agentId === worst?.agentId ? ("accent" as const) : ("faint" as const),
          endLabel: { name: a.agentId, value: last(a.rates) },
          hidden: !drawn.has(a.agentId),
        }))
      : []),
    {
      id: "__all",
      values: overallRates,
      tone: "primary",
      endLabel: {
        name: agent ?? (multi ? "all agents" : (agentRates[0]?.agentId ?? "all agents")),
        value: last(overallRates),
      },
    },
  ];
  const shown = series.filter((x) => !x.hidden);
  const axis = percentAxis(shown.flatMap((x) => x.values.filter((v): v is number => v !== null)));

  // The table's ticks: each row links to the set with that agent toggled; an empty set is the default again.
  const ticked = selectable ? [...drawn] : picked;
  const atLimit = selectable && ticked.length >= MAX_TICKED;
  // Every row goes to the table, which filters by q itself (on the server render too), so
  // clearing the find field brings the others back.
  const tableRows: AgentTableRow[] = rows.map((r) => {
    const checked = selectable ? drawn.has(r.agentId) : agent === r.agentId;
    const next = checked ? ticked.filter((id) => id !== r.agentId) : [...ticked, r.agentId];
    return {
      agentId: r.agentId,
      rate: r.rate === null ? "–" : `${r.rate}%`,
      delta: deltaText(r.delta),
      runs: fmtInt(r.runs),
      rates: r.rates,
      drawn: drawn.has(r.agentId),
      worst: r.agentId === worst?.agentId,
      checked,
      href: !checked && atLimit ? null : trendHref({ agent: next, q: q || undefined }),
    };
  });
  const hiddenParams: Array<[string, string]> = [
    ...(range === "1m" ? [] : [["range", range] as [string, string]]),
    ...(project ? [["project", project.id] as [string, string]] : []),
    ...picked.map((id) => ["agent", id] as [string, string]),
  ];
  const showAllParams = new URLSearchParams([...hiddenParams, ...(q ? [["q", q]] : []), ["all", "1"]]);
  const ticks = xTickIndexes(s.starts.length).map((i) => ({
    index: i,
    label: bucketLabel(s.starts[i] ?? "", s.bucket),
  }));

  let callout: string | null = null;
  if (worst) {
    const recent = agentRecentReviewReasons(worst.agentId, project?.path);
    const top = recent.reasons[0];
    callout = `${worst.agentId} fell ${worst.drop} points in ${unitCount(worst.buckets, s.bucket)}`;
    if (top && recent.reviews > 0) {
      callout += `: ${top.count} of its last ${recent.reviews} reviews were ${REVIEW_REASON_LABELS[top.reason]}`;
    }
  }

  // Sparse: the scope's first run falls inside the period, so the buckets before it are a band.
  const firstIdx = s.overall.findIndex((c) => c.finished > 0);
  const sparse = s.firstRunAt !== null && s.firstRunAt >= `${s.starts[0]}T` && firstIdx > 0;
  const subtitle = sparse
    ? `${RANGE_LABELS[range]} selected · data since ${dayLabel(s.firstRunAt as string)} (${unitCount(s.starts.length - firstIdx, s.bucket)})`
    : `share of finished runs with no review reason, per ${unit}${
        selectable
          ? ` · tick agents in the table to draw them (kept in the URL); default: ${
              fewAgents ? "every agent" : "the most-worsening and the 4 lowest"
            }`
          : multi
            ? " · line ends name the agent"
            : ""
      }`;

  // ---- finished runs per bucket (the ticked set when several agents are ticked) ----
  const stacks = [
    { key: "clean", label: "clean", tone: "ok" as const, values: scoped.overall.map((c) => c.clean) },
    { key: "review", label: "needs review", tone: "warn" as const, values: scoped.overall.map((c) => c.needsReview) },
    { key: "cancelled", label: "cancelled", tone: "muted" as const, values: scoped.overall.map((c) => c.cancelled) },
  ];
  const counts = countAxis(Math.max(...scoped.overall.map((c) => c.finished)));
  const barTicks = xTickIndexes(s.starts.length, 5).map((i) => ({
    index: i,
    label: bucketLabel(s.starts[i] ?? "", s.bucket),
  }));

  // ---- why runs needed review ----
  const byReason = new Map(scoped.reasons.map((r) => [r.reason, r.count]));
  const reasonRows = (Object.keys(REVIEW_REASON_LABELS) as ReviewReason[])
    .map((reason, order) => ({ reason, order, count: byReason.get(reason) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.order - b.order);
  const maxReason = Math.max(1, ...reasonRows.map((r) => r.count));

  return (
    <>
      {header}
      <section className="card trend-panel rate-panel" aria-labelledby="trend-rate">
        <h2 className="panel-title" id="trend-rate">
          Clean rate by agent
        </h2>
        <p className="panel-sub">{subtitle}</p>
        {callout && <p className="trend-callout">{callout}</p>}
        <div className="rate-body">
          <LineChart
            ariaLabel={`Clean rate per ${unit}, ${shown.map((x) => `${x.endLabel?.name} ${x.endLabel?.value}`).join(", ")}`}
            buckets={s.starts.length}
            xTicks={ticks}
            y={{ ...axis, format: (v) => `${v}%` }}
            series={series}
            height={LINE_HEIGHT}
            band={
              sparse ? { toIndex: firstIdx, label: `no runs before ${dayLabel(s.firstRunAt as string)}` } : undefined
            }
          />
          <AgentTable
            rows={tableRows}
            selectable={selectable || Boolean(agent)}
            limitHint={atLimit ? `${MAX_TICKED} agents at most · untick one to draw another` : null}
            q={q}
            hidden={hiddenParams}
            expanded={one(sp.all) === "1"}
            showAllHref={`/trends?${showAllParams}`}
          />
        </div>
      </section>

      <div className="trend-pair">
        <section className="card trend-panel" aria-labelledby="trend-finished">
          <h2 className="panel-title" id="trend-finished">
            Finished runs per {unit}
          </h2>
          <ChartLegend items={stacks} />
          <StackedBars
            ariaLabel={`Finished runs per ${unit}: ${fmtInt(scoped.totals.clean)} clean, ${fmtInt(scoped.totals.needsReview)} needs review, ${fmtInt(scoped.totals.cancelled)} cancelled`}
            names={s.starts.map((d) => bucketLabel(d, s.bucket))}
            xTicks={barTicks}
            stacks={stacks}
            y={counts}
            height={BAR_HEIGHT}
          />
        </section>

        <section className="card trend-panel" aria-labelledby="trend-reasons">
          <h2 className="panel-title" id="trend-reasons">
            Why runs needed review
          </h2>
          <p className="panel-sub">
            {fmtInt(scoped.totals.needsReview)} of {fmtInt(scoped.totals.finished)} finished runs · each reason opens
            Runs filtered by it
          </p>
          <ul className="reason-rows">
            {reasonRows.map((r) => (
              <li key={r.reason}>
                <Link href={runsHref({ outcome: "needs_review", reason: r.reason })}>
                  <span className="reason-name">{REVIEW_REASON_LABELS[r.reason]}</span>
                  <span className="reason-bar" aria-hidden="true">
                    <span style={{ width: `${(r.count / maxReason) * 100}%` }} />
                  </span>
                  <span className="reason-count">
                    {fmtInt(r.count)} · {scoped.totals.needsReview ? fmtPct(r.count, scoped.totals.needsReview) : "0"}
                  </span>
                  <span className="reason-go" aria-hidden="true">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="trend-note">{NOTE}</p>
    </>
  );
}

const NOTE =
  "Agent and project filters carry over from Runs. Percentages are of finished runs (running excluded). Cancelled runs are not clean and not needs-review. Buckets are UTC.";
