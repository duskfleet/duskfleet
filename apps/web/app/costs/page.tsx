import { budgetLabel, COST_SPLITS, type CostSplitBy, costLabels, TREND_RANGES, type TrendRange } from "@duskfleet/core";
import Link from "next/link";
import { type BarRule, ChartLegend, StackedBars } from "@/components/charts/StackedBars";
import { budgetPerBucket, fmtUsdShort, moneyAxis, SPLIT_LABELS, SPLIT_PLURALS } from "@/lib/costs";
import { costs, listAgents, listProjects, modelStats, monthSpend, scopeBudget } from "@/lib/data";
import { fmtCost, fmtDuration, fmtInt, fmtPct, fmtSplit, shortModel } from "@/lib/format";
import {
  bucketLabel,
  granularityText,
  RANGE_LABELS,
  RANGE_PHRASES,
  unitCount,
  unitName,
  xTickIndexes,
} from "@/lib/trends";

export const dynamic = "force-dynamic";

type Search = { agent?: string; project?: string; range?: string; by?: string };

const isRange = (v: string | undefined): v is TrendRange => (TREND_RANGES as readonly string[]).includes(v ?? "");
const isSplit = (v: string | undefined): v is CostSplitBy => (COST_SPLITS as readonly string[]).includes(v ?? "");

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }) {
  const { agent, project } = await searchParams;
  const parts = ["Costs", project, agent].filter(Boolean);
  return { title: `${parts.join(" · ")} · Duskfleet` };
}

const BAR_HEIGHT = 260;
/** Up to this many bars every total is printed above its bar; past it only the current one. */
const MAX_TOP_LABELS = 13;

export default async function CostsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const range: TrendRange = isRange(sp.range) ? sp.range : "1m";
  const by: CostSplitBy = isSplit(sp.by) ? sp.by : "agent";
  const agents = listAgents();
  const projects = listProjects();
  // Unknown ids are dropped, as on the Runs page, rather than showing an empty chart.
  const agent = sp.agent && agents.some((a) => a.id === sp.agent) ? sp.agent : undefined;
  const project = sp.project ? projects.find((p) => p.id === sp.project) : undefined;
  const scope = { agentId: agent, projectPath: project?.path };
  const now = new Date();
  const s = costs(range, by, scope);
  const month = monthSpend(scope);
  const budget = scopeBudget({ agentId: agent, projectId: project?.id });
  const unit = unitName(s.bucket);

  const qs = (base: string, next: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged: Search = { agent, project: project?.id, ...next };
    for (const k of ["agent", "project", "range", "by"] as const) {
      const v = merged[k];
      if (v) p.set(k, v);
    }
    const q = p.toString();
    return q ? `${base}?${q}` : base;
  };
  const costsHref = (next: Partial<Search>) =>
    qs("/costs", { range: range === "1m" ? undefined : range, by: by === "agent" ? undefined : by, ...next });

  const kept = [
    agent ? { key: "agent", label: `agent: ${agent}`, href: costsHref({ agent: undefined }) } : null,
    project ? { key: "project", label: `project: ${project.id}`, href: costsHref({ project: undefined }) } : null,
  ].filter((k): k is { key: string; label: string; href: string } => k !== null);

  // ---- KPIs ----
  const monthWords = costLabels(month.cost);
  const periodUsd = s.total + s.gateTotal;
  const warnUsd = budget ? (budget.amountUsd * budget.warnPercent) / 100 : 0;

  // ---- spend per bucket ----
  const projectIds = new Map(projects.map((p) => [p.path.replace(/\/+$/, ""), p.id]));
  const keyLabel = (key: string) =>
    by === "model"
      ? shortModel(key)
      : by === "project"
        ? (projectIds.get(key.replace(/\/+$/, "")) ?? key.split("/").filter(Boolean).pop() ?? key)
        : key;
  const top = s.series[0];
  const stacks = s.series.map((x, i) => ({
    key: x.key,
    label: keyLabel(x.key),
    tone: i === 0 ? ("accent" as const) : ("faint" as const),
    values: x.values,
  }));
  const legend = [
    ...(top ? [{ key: "top", label: `${keyLabel(top.key)} (top spender)`, tone: "accent" as const }] : []),
    ...(s.series.length > 1
      ? [{ key: "others", label: `other ${SPLIT_PLURALS[by]} (one segment each)`, tone: "faint" as const }]
      : []),
  ];
  const last = s.starts.length - 1;
  const topLabels = s.totals.map((t, i) => {
    if (i === last) return `${fmtUsdShort(t)} so far`;
    return t > 0 && s.starts.length <= MAX_TOP_LABELS ? fmtUsdShort(t) : null;
  });
  const perBucket = budget ? budgetPerBucket(budget.amountUsd, s.bucket) : 0;
  const rules: BarRule[] = budget
    ? [
        {
          value: perBucket,
          tone: "budget",
          label:
            s.bucket === "month"
              ? `budget ${fmtUsdShort(budget.amountUsd)}`
              : `budget ${fmtUsdShort(budget.amountUsd)} a month · ${fmtUsdShort(perBucket)} a ${unit}`,
        },
        {
          value: (perBucket * budget.warnPercent) / 100,
          tone: "warn",
          label: `warn ${budget.warnPercent}% · ${fmtUsdShort((perBucket * budget.warnPercent) / 100)}`,
        },
      ]
    : [];
  const axis = moneyAxis(Math.max(...s.totals, perBucket));
  const ticks = xTickIndexes(s.starts.length, s.starts.length <= MAX_TOP_LABELS ? MAX_TOP_LABELS : 7).map((i) => ({
    index: i,
    label: bucketLabel(s.starts[i] ?? "", s.bucket),
  }));
  const budgetHint = agent
    ? `npm run cli -- budgets set agent ${agent} --amount <usd>`
    : project
      ? `npm run cli -- budgets set project ${project.id} --amount <usd>`
      : "npm run cli -- budgets set global --amount <usd>";

  // ---- by model, same period and scope ----
  const models = modelStats({ ...scope, from: `${s.starts[0]}T00:00:00.000Z` });
  const modelCost = {
    apiUsd: models.reduce((n, m) => n + m.cost.apiUsd, 0),
    subscriptionUsd: models.reduce((n, m) => n + m.cost.subscriptionUsd, 0),
  };
  const modelWords = costLabels(modelCost);
  const modelTotal = models.reduce((n, m) => n + m.costUsd, 0);

  return (
    <>
      <div className="page-head">
        <h1>Costs</h1>
        <Link href={qs("/", {})} className="back-link">
          ← back to Runs
        </Link>
      </div>
      <div className="trend-toolbar">
        <nav className="period" aria-label="Period">
          {TREND_RANGES.map((r) => (
            <Link
              key={r}
              href={costsHref({ range: r === "1m" ? undefined : r })}
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
        <span className="split">
          split
          <nav className="period" aria-label="Split">
            {COST_SPLITS.map((b) => (
              <Link
                key={b}
                href={costsHref({ by: b === "agent" ? undefined : b })}
                className={b === by ? "on" : ""}
                aria-current={b === by ? "true" : undefined}
              >
                {SPLIT_LABELS[b]}
              </Link>
            ))}
          </nav>
        </span>
      </div>

      <section className="stats cost-kpis" aria-label="Spend">
        <div className="stat" title={monthWords.basis === "api" ? undefined : (monthWords.note ?? undefined)}>
          <div className="label">{monthWords.basis === "api" ? "Spent this month" : "Used this month"}</div>
          <div className="value">{fmtCost(month.costUsd)}</div>
          <div className="sub">
            {budget
              ? `of ${fmtCost(budget.amountUsd)} ${budgetLabel(budget)} budget · ${Math.round(budget.percent)}%`
              : "no monthly budget for this scope"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Last {unitCount(s.starts.length, s.bucket)}</div>
          <div className="value">{fmtCost(periodUsd)}</div>
          <div className="sub">
            avg {fmtCost(periodUsd / s.starts.length)} a {unit}
          </div>
        </div>
        <div className="stat">
          <div className="label">Avg per run</div>
          <div className="value">{month.runs ? fmtCost(month.runsCostUsd / month.runs) : "–"}</div>
          <div className="sub">{fmtInt(month.runs)} runs this month</div>
        </div>
        <div className="stat">
          <div className="label">Budget warning</div>
          {budget ? (
            <>
              <div className="value warn">at {budget.warnPercent}%</div>
              <div className="sub">
                {fmtCost(warnUsd)} · {budget.hardStop ? "hard stop" : "warn only, no hard stop"} at{" "}
                {fmtCost(budget.amountUsd)}
              </div>
            </>
          ) : (
            <>
              <div className="value faint-value">none</div>
              <div className="sub">set a budget to get a warning</div>
            </>
          )}
        </div>
      </section>

      <section className="card trend-panel cost-panel" aria-labelledby="cost-spend">
        <div className="panel-head">
          <h2 className="panel-title" id="cost-spend">
            Spend per {unit}, {SPLIT_LABELS[by].toLowerCase()}
          </h2>
          {periodUsd > 0 && <ChartLegend items={legend} />}
        </div>
        {periodUsd === 0 ? (
          <div className="trend-empty">
            <strong>No spend in {RANGE_PHRASES[range]}</strong>
            <span>Costs appear here once runs report them.{range !== "1y" && " Try a longer period."}</span>
            {range !== "1y" && (
              <Link href={costsHref({ range: "1y" })} className="btn">
                Show 1 year
              </Link>
            )}
          </div>
        ) : (
          <>
            <p className="panel-sub">
              USD, stacked · the top spender is highlighted, hover a segment for its {SPLIT_PLURALS[by].slice(0, -1)}{" "}
              and amount ·{" "}
              {budget
                ? s.bucket === "month"
                  ? "dashed: monthly budget, dotted: warning"
                  : `dashed: monthly budget pro rata per ${unit}, dotted: warning`
                : "no budget for this scope, so no budget line"}
            </p>
            <StackedBars
              ariaLabel={`Spend per ${unit} ${SPLIT_LABELS[by].toLowerCase()}: ${fmtCost(s.total)} over ${RANGE_PHRASES[range]}${budget ? `, monthly budget ${fmtCost(budget.amountUsd)}` : ""}`}
              names={s.starts.map((d) => bucketLabel(d, s.bucket))}
              xTicks={ticks}
              stacks={stacks}
              y={axis}
              height={BAR_HEIGHT}
              format={fmtUsdShort}
              topLabels={topLabels}
              rules={rules}
            />
            {!budget && (
              <p className="panel-foot">
                Set a budget to see it here: <code>{budgetHint}</code> (or set_budget over MCP).
              </p>
            )}
            {s.gateTotal > 0 && (
              <p className="panel-foot" title="Schedule gate agents decide whether a tick has work">
                {fmtCost(s.total)} on runs · {fmtCost(s.gateTotal)} on gates, not in the bars
              </p>
            )}
          </>
        )}
      </section>

      {models.length > 0 && (
        <section className="card model-card cost-models" aria-label="Spend by model">
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Runs</th>
                <th className="num">Avg duration</th>
                <th className="num">Avg {modelWords.column === "Cost" ? "cost" : modelWords.column}</th>
                <th className="num">Total</th>
                <th>Share of spend</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model}>
                  <td>
                    <span className="pill model" title={m.model}>
                      {shortModel(m.model)}
                    </span>
                  </td>
                  <td className="num">{fmtInt(m.runs)}</td>
                  <td className="num">{fmtDuration(m.avgDurationMs)}</td>
                  <td className="num">{fmtCost(m.avgCostUsd)}</td>
                  <td className="num">{fmtSplit(m.cost, modelWords.basis)}</td>
                  <td>
                    <span className="share">
                      <span className="share-bar" aria-hidden="true">
                        <span style={{ width: `${modelTotal ? (m.costUsd / modelTotal) * 100 : 0}%` }} />
                      </span>
                      <span className="share-pct">{fmtPct(m.costUsd, modelTotal)}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>All models</td>
                <td className="num">{fmtInt(models.reduce((n, m) => n + m.runs, 0))}</td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num">{fmtSplit(modelCost, modelWords.basis)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}
      <p className="trend-note">
        Split switch re-stacks the same bars by agent, project or model. With an agent or project filter, the overlay is
        that scope&apos;s budget when one exists; a filtered view never borrows the global one. The By model table
        counts finished runs of the period{modelWords.basis === "subscription" ? `, ${modelWords.note}` : ""}. Buckets
        and budget months are UTC.
      </p>
    </>
  );
}
