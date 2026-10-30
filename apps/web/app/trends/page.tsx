import { REVIEW_REASON_LABELS, type ReviewReason, TREND_RANGES, type TrendRange } from "@duskfleet/core";
import Link from "next/link";
import { LineChart, type LineSeries } from "@/components/charts/LineChart";
import { ChartLegend, StackedBars } from "@/components/charts/StackedBars";
import { agentRecentReviewReasons, listAgents, listProjects, trends } from "@/lib/data";
import { fmtInt, fmtPct } from "@/lib/format";
import {
  bucketLabel,
  cleanRate,
  countAxis,
  dayLabel,
  granularityText,
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

type Search = { agent?: string; project?: string; range?: string };

const isRange = (v: string | undefined): v is TrendRange => (TREND_RANGES as readonly string[]).includes(v ?? "");

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }) {
  const { agent, project } = await searchParams;
  const parts = ["Clean-run trend", project, agent].filter(Boolean);
  return { title: `${parts.join(" · ")} · Duskfleet` };
}

const LINE_HEIGHT = 230;
const BAR_HEIGHT = 200;

export default async function TrendsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const range: TrendRange = isRange(sp.range) ? sp.range : "1m";
  const agents = listAgents();
  const projects = listProjects();
  // Unknown ids are dropped, as on the Runs page, rather than showing an empty chart.
  const agent = sp.agent && agents.some((a) => a.id === sp.agent) ? sp.agent : undefined;
  const project = sp.project ? projects.find((p) => p.id === sp.project) : undefined;
  const now = new Date();
  const s = trends(range, { agentId: agent, projectPath: project?.path });
  const unit = unitName(s.bucket);

  const qs = (base: string, next: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged: Search = { agent, project: project?.id, ...next };
    for (const k of ["agent", "project", "range", "outcome", "reason"] as const) {
      const v = (merged as Record<string, string | undefined>)[k];
      if (v) p.set(k, v);
    }
    const q = p.toString();
    return q ? `${base}?${q}` : base;
  };
  const trendHref = (next: Partial<Search>) => qs("/trends", { range: range === "1m" ? undefined : range, ...next });
  const runsHref = (extra: Record<string, string> = {}) => qs("/", extra as Partial<Search>);

  const kept = [
    agent ? { key: "agent", label: `agent: ${agent}`, href: trendHref({ agent: undefined }) } : null,
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
  const last = (rates: ReadonlyArray<number | null>) => {
    const i = pointIndexes(rates).at(-1);
    return i === undefined ? "" : ` ${Math.round(rates[i] as number)}%`;
  };
  const series: LineSeries[] = [
    ...(multi
      ? agentRates.map((a) => ({
          id: a.agentId,
          values: a.rates,
          tone: a.agentId === worst?.agentId ? ("accent" as const) : ("faint" as const),
          endLabel: `${a.agentId}${last(a.rates)}`,
        }))
      : []),
    {
      id: "__all",
      values: overallRates,
      tone: "primary",
      endLabel: `${agent ?? (multi ? "all agents" : (agentRates[0]?.agentId ?? "all agents"))}${last(overallRates)}`,
    },
  ];
  const axis = percentAxis(series.flatMap((x) => x.values.filter((v): v is number => v !== null)));
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
    : `share of finished runs with no review reason, per ${unit}${multi ? " · line ends name the agent" : ""}`;

  // ---- finished runs per bucket ----
  const stacks = [
    { key: "clean", label: "clean", tone: "ok" as const, values: s.overall.map((c) => c.clean) },
    { key: "review", label: "needs review", tone: "warn" as const, values: s.overall.map((c) => c.needsReview) },
    { key: "cancelled", label: "cancelled", tone: "muted" as const, values: s.overall.map((c) => c.cancelled) },
  ];
  const counts = countAxis(Math.max(...s.overall.map((c) => c.finished)));
  const barTicks = xTickIndexes(s.starts.length, 5).map((i) => ({
    index: i,
    label: bucketLabel(s.starts[i] ?? "", s.bucket),
  }));

  // ---- why runs needed review ----
  const byReason = new Map(s.reasons.map((r) => [r.reason, r.count]));
  const reasonRows = (Object.keys(REVIEW_REASON_LABELS) as ReviewReason[])
    .map((reason, order) => ({ reason, order, count: byReason.get(reason) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.order - b.order);
  const maxReason = Math.max(1, ...reasonRows.map((r) => r.count));

  return (
    <>
      {header}
      <section className="card trend-panel" aria-labelledby="trend-rate">
        <h2 className="panel-title" id="trend-rate">
          Clean rate by agent
        </h2>
        <p className="panel-sub">{subtitle}</p>
        <LineChart
          ariaLabel={`Clean rate per ${unit}, ${series.map((x) => x.endLabel).join(", ")}`}
          buckets={s.starts.length}
          xTicks={ticks}
          y={{ ...axis, format: (v) => `${v}%` }}
          series={series}
          height={LINE_HEIGHT}
          band={sparse ? { toIndex: firstIdx, label: `no runs before ${dayLabel(s.firstRunAt as string)}` } : undefined}
          callout={callout}
        />
      </section>

      <div className="trend-pair">
        <section className="card trend-panel" aria-labelledby="trend-finished">
          <h2 className="panel-title" id="trend-finished">
            Finished runs per {unit}
          </h2>
          <ChartLegend items={stacks} />
          <StackedBars
            ariaLabel={`Finished runs per ${unit}: ${fmtInt(s.totals.clean)} clean, ${fmtInt(s.totals.needsReview)} needs review, ${fmtInt(s.totals.cancelled)} cancelled`}
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
            {fmtInt(s.totals.needsReview)} of {fmtInt(s.totals.finished)} finished runs · each reason opens Runs
            filtered by it
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
                    {fmtInt(r.count)} · {s.totals.needsReview ? fmtPct(r.count, s.totals.needsReview) : "0"}
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
