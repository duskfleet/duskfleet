import { budgetLabel, COST_SPLITS, type CostSplitBy, costLabels, TREND_RANGES, type TrendRange } from "@duskfleet/core";
import Link from "next/link";
import { type CostSplitOption, CostTable, type CostTableRow } from "@/components/charts/CostTable";
import { type BarEnd, type BarRule, StackedBars } from "@/components/charts/StackedBars";
import {
  budgetPerBucket,
  costRows,
  costStacks,
  fmtUsd2,
  fmtUsdShort,
  moneyAxis,
  resolveTicks,
  SPLIT_NOUNS,
  SPLIT_PLURALS,
  timesText,
  toggleTick,
} from "@/lib/costs";
import { cli, costs, finishedRunsBy, listProjects, monthSpend, scopeBudget } from "@/lib/data";
import { fmtCost, fmtInt, shortModel } from "@/lib/format";
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

type Param = string | string[] | undefined;
type Search = { agent?: Param; project?: Param; model?: Param; range?: Param; by?: Param; q?: Param; all?: Param };

const isRange = (v: string | undefined): v is TrendRange => (TREND_RANGES as readonly string[]).includes(v ?? "");
const isSplit = (v: string | undefined): v is CostSplitBy => (COST_SPLITS as readonly string[]).includes(v ?? "");
const one = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);
/** A split's ticks as the URL holds them: null when absent (the default ticks), [] when explicitly empty. */
const tickParam = (v: Param): string[] | null =>
  v === undefined ? null : [...new Set((Array.isArray(v) ? v : [v]).filter(Boolean))];

export async function generateMetadata() {
  return { title: "Costs · Duskfleet" };
}

const BAR_HEIGHT = 232;

export default async function CostsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const rangeParam = one(sp.range);
  const range: TrendRange = isRange(rangeParam) ? rangeParam : "1m";
  const byParam = one(sp.by);
  const by: CostSplitBy = isSplit(byParam) ? byParam : "agent";
  const q = one(sp.q)?.trim() ?? "";
  const projects = listProjects();
  const now = new Date();
  const s = costs(range, by);
  const month = monthSpend();
  // Ticks never filter the page: the totals, the KPIs and the budget stay the global ones.
  const budget = scopeBudget({});
  const unit = unitName(s.bucket);
  const period = unitCount(s.starts.length, s.bucket);

  // ---- rows: one per agent, project path or model of the period ----
  const finishedBy = finishedRunsBy(by, s.starts[0] ?? now.toISOString().slice(0, 10));
  const rows = costRows(s.series, finishedBy.runs, finishedBy.spent);
  const projectIds = new Map(projects.map((p) => [p.path.replace(/\/+$/, ""), p.id]));
  const projectId = (path: string) => projectIds.get(path.replace(/\/+$/, ""));
  const label = (key: string) =>
    by === "model"
      ? shortModel(key)
      : by === "project"
        ? (projectId(key) ?? key.split("/").filter(Boolean).pop() ?? key)
        : key;
  // In the URL a project is its registry id when it has one, as on the Runs page.
  const urlKey = (key: string) => (by === "project" ? (projectId(key) ?? key) : key);
  const fromUrl = new Map(rows.map((r) => [urlKey(r.key), r.key]));

  // Each split keeps its own ticks in its own param; the others ride along untouched.
  const raw: Record<CostSplitBy, string[] | null> = {
    agent: tickParam(sp.agent),
    project: tickParam(sp.project),
    model: tickParam(sp.model),
  };
  const asked = raw[by];
  const ticked = resolveTicks(asked === null ? null : asked.map((k) => fromUrl.get(k) ?? k), rows);
  const tickedSet = new Set(ticked);

  type Next = Partial<Record<CostSplitBy, string[] | null>> & { range?: TrendRange; by?: CostSplitBy; q?: string };
  const costsHref = (next: Next) => {
    const p = new URLSearchParams();
    const r = next.range ?? range;
    const b = next.by ?? by;
    if (r !== "1m") p.set("range", r);
    if (b !== "agent") p.set("by", b);
    for (const split of COST_SPLITS) {
      const values = split in next ? next[split] : raw[split];
      for (const v of values ?? []) p.append(split, v);
      if (values && values.length === 0) p.append(split, "");
    }
    if (next.q) p.set("q", next.q);
    const query = p.toString();
    return query ? `/costs?${query}` : "/costs";
  };
  const runsHref = (key: string): string | null => {
    if (by === "agent") return `/?agent=${encodeURIComponent(key)}`;
    const id = by === "project" ? projectId(key) : undefined;
    return id ? `/?project=${encodeURIComponent(id)}` : null;
  };
  const nameHref = (key: string): string | null =>
    by === "agent" ? `/agents/${encodeURIComponent(key)}` : runsHref(key);

  // ---- KPIs ----
  const monthWords = costLabels(month.cost);
  const periodUsd = s.total + s.gateTotal;
  const finished = rows.reduce((n, r) => n + r.runs, 0);
  // Same runs on both sides: a running run's cost is in the bars but not in the average.
  const avgRun = finished ? rows.reduce((n, r) => n + r.finishedSpent, 0) / finished : null;

  // ---- chart ----
  const stacks = costStacks(s.series, s.totals, ticked).map((x) => ({
    key: x.key,
    label: x.row ? label(x.row) : x.tone === "others" ? "others" : "all",
    tone: x.tone,
    values: x.values,
    row: x.row,
  }));
  const othersCount = rows.filter((r) => r.spent > 0 && !tickedSet.has(r.key)).length;
  const othersUsd = rows.filter((r) => !tickedSet.has(r.key)).reduce((n, r) => n + r.spent, 0);
  const ends: BarEnd[] = stacks.map((x, i) => {
    if (x.row) {
      const r = rows.find((row) => row.key === x.row);
      return { key: x.key, name: label(x.row), value: fmtUsd2(r?.spent ?? 0), strong: i === 0 };
    }
    if (x.tone === "others") return { key: x.key, name: `${othersCount} others`, value: fmtUsd2(othersUsd) };
    return { key: x.key, name: `all ${SPLIT_PLURALS[by]}`, value: fmtUsd2(s.total) };
  });
  const perBucket = budget ? budgetPerBucket(budget.amountUsd, s.bucket) : 0;
  const rules: BarRule[] = budget
    ? [
        {
          value: perBucket,
          tone: "budget",
          label:
            s.bucket === "month"
              ? `budget ${fmtUsdShort(budget.amountUsd)} a month`
              : `budget ${fmtUsdShort(budget.amountUsd)} a month · ${fmtCost(perBucket)} a ${unit}`,
        },
        {
          value: (perBucket * budget.warnPercent) / 100,
          tone: "warn",
          label: `warn ${budget.warnPercent}% · ${fmtCost((perBucket * budget.warnPercent) / 100)}`,
        },
      ]
    : [];
  const axis = moneyAxis(Math.max(...s.totals, perBucket));
  const ticks = xTickIndexes(s.starts.length).map((i) => ({
    index: i,
    label: bucketLabel(s.starts[i] ?? "", s.bucket),
  }));
  const budgetHint = cli("budgets set global --amount <usd>");

  // ---- insight: the top spender ----
  const top = rows[0];
  const topRuns = top ? runsHref(top.key) : null;
  let insight: string | null = null;
  if (top && top.spent > 0) {
    insight = `${label(top.key)} spent ${fmtUsd2(top.spent)} in ${period}, ${Math.round(top.share * 100)}% of the total`;
    if (top.runs > 0 && top.avg !== null) {
      insight += `: ${fmtInt(top.runs)} runs at ${fmtUsd2(top.avg)} each`;
      const times = rows.length > 1 && avgRun ? timesText(top.avg, avgRun) : null;
      if (times) insight += `, ${times} the average run`;
    }
  }

  // ---- table ----
  const tableRows: CostTableRow[] = rows.map((r) => {
    const rank = ticked.indexOf(r.key);
    return {
      key: r.key,
      label: label(r.key),
      title: by === "agent" ? undefined : r.key,
      spent: fmtUsd2(r.spent),
      share: `${Math.round(r.share * 100)}%`,
      runs: fmtInt(r.runs),
      avg: r.avg === null ? "–" : fmtUsd2(r.avg),
      tone: rank === 0 ? "accent" : rank > 0 ? "faint" : null,
      checked: rank >= 0,
      tickHref: costsHref({ [by]: toggleTick(ticked, r.key, rows).map((k) => (k ? urlKey(k) : k)) } as Next),
      nameHref: nameHref(r.key),
      runsHref: runsHref(r.key),
    };
  });
  const splits: CostSplitOption[] = COST_SPLITS.map((b) => ({
    key: b,
    label: SPLIT_NOUNS[b],
    href: costsHref({ by: b }),
    on: b === by,
  }));
  const hiddenParams: Array<[string, string]> = [
    ...(range === "1m" ? [] : [["range", range] as [string, string]]),
    ...(by === "agent" ? [] : [["by", by] as [string, string]]),
    ...COST_SPLITS.flatMap((split) =>
      raw[split] === null
        ? []
        : (raw[split] as string[]).length
          ? (raw[split] as string[]).map((v) => [split, v] as [string, string])
          : [[split, ""] as [string, string]],
    ),
  ];
  const showAllParams = new URLSearchParams([...hiddenParams, ...(q ? [["q", q]] : []), ["all", "1"]]);

  const subtitle = `USD, stacked · tick rows in the table to draw them (kept in the URL); default: the top ${
    rows.filter((r) => r.spent > 0).length < 5 ? "spenders" : "5 spenders"
  } · the rest fold into one outlined "others" segment`;

  return (
    <>
      <div className="page-head">
        <h1>Costs</h1>
        <Link href="/" className="back-link">
          ← back to Runs
        </Link>
      </div>
      <div className="trend-toolbar">
        <nav className="period" aria-label="Period">
          {TREND_RANGES.map((r) => (
            <Link
              key={r}
              href={costsHref({ range: r })}
              className={r === range ? "on" : ""}
              aria-current={r === range ? "true" : undefined}
            >
              {RANGE_LABELS[r]}
            </Link>
          ))}
        </nav>
        <span className="granularity">{granularityText(s.bucket, s.starts.length, now)}</span>
      </div>

      <section className="stats cost-kpis" aria-label="Spend">
        <div className="stat" title={monthWords.basis === "api" ? undefined : (monthWords.note ?? undefined)}>
          <div className="label">{monthWords.basis === "api" ? "Spent this month" : "Used this month"}</div>
          <div className="value">{fmtCost(month.costUsd)}</div>
          <div className="sub">
            {budget
              ? `of ${fmtUsd2(budget.amountUsd)} ${budgetLabel(budget)} budget · ${Math.round(budget.percent)}%`
              : "no monthly budget for this scope"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Last {period}</div>
          <div className="value">{fmtCost(periodUsd)}</div>
          <div className="sub">
            avg {fmtCost(periodUsd / s.starts.length)} a {unit} · {fmtInt(finished)} runs
          </div>
        </div>
        <div className="stat">
          <div className="label">Avg per run</div>
          <div className="value">{avgRun === null ? "–" : fmtCost(avgRun)}</div>
          <div className="sub">
            {fmtInt(finished)} finished runs in {period}
          </div>
        </div>
      </section>

      <section className="card trend-panel cost-panel" aria-labelledby="cost-spend">
        <h2 className="panel-title" id="cost-spend">
          Spend per {unit}, by {SPLIT_NOUNS[by]}
        </h2>
        {rows.length === 0 ? (
          <div className="trend-empty">
            <strong>
              {s.gateTotal > 0 ? "No run spend" : "No spend"} in {RANGE_PHRASES[range]}
            </strong>
            <span>Costs appear here once runs report them.{range !== "1y" && " Try a longer period."}</span>
            {s.gateTotal > 0 && (
              <span title="Schedule gate agents decide whether a tick has work">
                {fmtCost(s.gateTotal)} on gates, not in the bars
              </span>
            )}
            {range !== "1y" && (
              <Link href={costsHref({ range: "1y" })} className="btn">
                Show 1 year
              </Link>
            )}
          </div>
        ) : (
          <>
            <p className="panel-sub">{subtitle}</p>
            {insight &&
              (topRuns ? (
                <Link href={topRuns} className="trend-callout">
                  {insight}
                </Link>
              ) : (
                <p className="trend-callout">{insight}</p>
              ))}
            <div className="rate-body cost-body">
              <div className="cost-chart">
                <StackedBars
                  ariaLabel={`Spend per ${unit} by ${SPLIT_NOUNS[by]}: ${fmtCost(s.total)} over ${RANGE_PHRASES[range]}${
                    ends.length ? `, ${ends.map((e) => `${e.name} ${e.value}`).join(", ")}` : ""
                  }${budget ? `, monthly budget ${fmtCost(budget.amountUsd)}` : ""}`}
                  names={s.starts.map((d) => bucketLabel(d, s.bucket))}
                  xTicks={ticks}
                  stacks={stacks}
                  y={axis}
                  height={BAR_HEIGHT}
                  format={fmtUsdShort}
                  rules={rules}
                  ends={ends}
                />
                {!budget && (
                  <p className="panel-foot">
                    No budget for this scope, so no budget line. Set one: <code>{budgetHint}</code> (or set_budget over
                    MCP)
                  </p>
                )}
                {s.gateTotal > 0 && (
                  <p className="panel-foot" title="Schedule gate agents decide whether a tick has work">
                    {fmtCost(s.total)} on runs · {fmtCost(s.gateTotal)} on gates, not in the bars
                  </p>
                )}
              </div>
              <CostTable
                rows={tableRows}
                noun={SPLIT_NOUNS[by]}
                plural={SPLIT_PLURALS[by]}
                splits={splits}
                total={{
                  spent: fmtUsd2(s.total),
                  share: s.total > 0 ? "100%" : "–",
                  runs: fmtInt(finished),
                  avg: avgRun === null ? "–" : fmtUsd2(avgRun),
                }}
                param={by}
                q={q}
                hidden={hiddenParams}
                expanded={one(sp.all) === "1"}
                showAllHref={`/costs?${showAllParams}`}
              />
            </div>
          </>
        )}
      </section>
      <p className="trend-note">
        The split sets what the table ranks (agent, project or model); ticked rows are drawn, the rest fold into
        &quot;others&quot;. Runs count finished runs of the period; the budget overlay is the global one, ticks never
        filter it. {monthWords.basis === "subscription" ? `${monthWords.note} ` : ""}UTC buckets.
      </p>
    </>
  );
}
