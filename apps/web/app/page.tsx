import { costLabels, REVIEW_REASON_LABELS, type ReviewReason, RUN_OUTCOMES, type RunOutcome } from "@duskfleet/core";
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RunTable } from "@/components/RunTable";
import {
  budgetAlerts,
  listAgents,
  listProjects,
  listRuns,
  listSchedules,
  modelStats,
  overview,
  type RunsFilter,
} from "@/lib/data";
import { fmtClock, fmtCost, fmtDayClock, fmtDuration, fmtInt, fmtPct, fmtSplit, shortModel } from "@/lib/format";

export const dynamic = "force-dynamic";

type Search = {
  agent?: string;
  project?: string;
  schedule?: string;
  q?: string;
  outcome?: string;
  reason?: string;
  limit?: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const OUTCOME_LABELS: Record<RunOutcome, string> = {
  needs_review: "needs review",
  clean: "clean",
  completed_review: "completed to review",
  failed: "failed",
};

const SUBSCRIPTION_TITLE =
  "Claude Code reports what each run would cost at API prices. On a subscription that is usage, not money: it is included in your plan, and runs share its usage limits with interactive use.";

const isOutcome = (v: string | undefined): v is RunOutcome => (RUN_OUTCOMES as readonly string[]).includes(v ?? "");
const isReason = (v: string | undefined): v is ReviewReason => Boolean(v && Object.hasOwn(REVIEW_REASON_LABELS, v));

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }) {
  const { agent, project } = await searchParams;
  const name = agent ? (listAgents().find((a) => a.id === agent)?.name ?? agent) : null;
  const parts = ["Runs", project, name].filter(Boolean);
  return { title: `${parts.join(" · ")} · Duskfleet` };
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const { agent, project, schedule } = sp;
  const q = sp.q?.trim() || undefined;
  const limit = Math.min(Math.max(Number(sp.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const projects = listProjects();
  const agents = listAgents();
  const projectPath = project ? projects.find((p) => p.id === project)?.path : undefined;
  // Unknown values are ignored rather than filtering everything out.
  const outcome = isOutcome(sp.outcome) ? sp.outcome : undefined;
  const reason = isReason(sp.reason) ? sp.reason : undefined;
  const filter: Omit<RunsFilter, "limit" | "status"> = {};
  if (agent) filter.agentId = agent;
  if (projectPath) filter.projectPath = projectPath;
  if (schedule) filter.scheduleId = schedule;
  if (q) filter.q = q;
  if (outcome) filter.outcome = outcome;
  if (reason) filter.reason = reason;
  const filtered = Boolean(agent || project || schedule || q || outcome || reason);

  const qs = (next: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged: Search = { agent, project, schedule, q, outcome, reason, ...next };
    for (const k of ["agent", "project", "schedule", "q", "outcome", "reason", "limit"] as const) {
      const v = merged[k];
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return s ? `/?${s}` : "/";
  };

  const running = listRuns({ ...filter, status: "running", limit: 50 });
  const recent = listRuns({ ...filter, limit }).filter((r) => r.status !== "running");
  // KPIs stay on the agent / project scope: the outcome tiles show the whole picture they filter.
  const o = overview({ agentId: filter.agentId, projectPath: filter.projectPath });
  const spend = costLabels(o.cost);
  const models = modelStats();
  const modelCost = {
    apiUsd: models.reduce((n, m) => n + m.cost.apiUsd, 0),
    subscriptionUsd: models.reduce((n, m) => n + m.cost.subscriptionUsd, 0),
  };
  const modelWords = costLabels(modelCost);
  const budgets = budgetAlerts();
  const agentName = agent ? (agents.find((a) => a.id === agent)?.name ?? agent) : null;
  const scheduleName = schedule ? (listSchedules().find((s) => s.id === schedule)?.name ?? schedule) : null;
  const activeLabel = [
    project,
    agentName,
    scheduleName ? `schedule "${scheduleName}"` : null,
    q ? `"${q}"` : null,
    outcome ? OUTCOME_LABELS[outcome] : null,
    reason ? REVIEW_REASON_LABELS[reason] : null,
  ]
    .filter(Boolean)
    .join(" / ");
  const outcomeCounts: Record<RunOutcome, number> = {
    needs_review: o.needsReview,
    clean: o.clean,
    completed_review: o.completed - o.clean,
    failed: o.failed,
  };
  const reasonCount = reason ? (o.reviewReasons.find((r) => r.reason === reason)?.count ?? 0) : 0;
  // The size of the filtered set, when the KPIs know it exactly. In-memory filters (schedule, q)
  // and a reason combined with another outcome than needs_review count what they found instead.
  const exactTotal =
    schedule || q
      ? null
      : reason
        ? !outcome || outcome === "needs_review"
          ? reasonCount
          : null
        : outcome
          ? outcomeCounts[outcome]
          : o.total;
  const total = exactTotal ?? recent.length + running.length;
  const hasMore = exactTotal !== null && recent.length >= limit && total > recent.length + running.length;
  const reviewOn = outcome === "needs_review";
  // The trend keeps the agent / project scope of the tiles, nothing else.
  const trendParams = new URLSearchParams();
  if (agent) trendParams.set("agent", agent);
  if (project) trendParams.set("project", project);
  const trendHref = trendParams.size ? `/trends?${trendParams}` : "/trends";

  return (
    <>
      <AutoRefresh intervalMs={3000} />
      <div className="page-head">
        <h1>
          Runs
          {filtered && <span className="count"> · {activeLabel}</span>}
        </h1>
        <span className="head-side">
          {filtered && (
            <span className="active-filter">
              showing {fmtInt(recent.length + running.length)} of {fmtInt(total)}
              <Link href="/" className="clear">
                × clear filters
              </Link>
            </span>
          )}
          <span className="note">{fmtDayClock(new Date())}</span>
        </span>
      </div>

      {budgets.map((b) => {
        const spent = b.state === "over";
        const words = costLabels(b.cost);
        // A budget on subscription runs brakes the quota shared with interactive use: a usage budget.
        const kind = words.basis === "subscription" ? "usage budget" : "budget";
        const label =
          b.scope === "global"
            ? `Global ${kind}`
            : `${kind[0]?.toUpperCase()}${kind.slice(1)} of ${b.scope} ${b.scopeId}`;
        const used = words.basis === "subscription" ? `usage of your subscription, at API value` : words.verb;
        const over = words.basis === "subscription" ? "Used up" : "Spent";
        return (
          <div key={b.id} className={`callout ${spent && b.hardStop ? "bad" : "warn"}`} style={{ margin: "0 0 16px" }}>
            <span className="icon">!</span>
            <div>
              <strong>
                {label}: {fmtCost(b.spentUsd)} of {fmtCost(b.amountUsd)} {used} this month ({b.percent}%).
              </strong>{" "}
              {words.basis === "mixed" && <>{fmtSplit(b.cost, "mixed")}. </>}
              {spent
                ? b.hardStop
                  ? `${over}: new runs in this scope are refused and its schedules were paused until the month turns (UTC) or the budget is raised.`
                  : `${over}; hard_stop is off, so runs still start.`
                : `Past its ${b.warnPercent}% warning threshold.`}
            </div>
          </div>
        );
      })}

      <div className="toolbar">
        <div className="filters">
          <span className="filter-label">Project</span>
          <Link href={qs({ project: undefined })} className={`chip ${project ? "" : "on"}`}>
            all
          </Link>
          {projects.map((p) => (
            <Link
              key={p.id}
              href={qs({ project: p.id })}
              className={`chip ${project === p.id ? "on" : ""}`}
              title={p.path}
            >
              {p.id}
            </Link>
          ))}
        </div>
        <div className="toolbar-row">
          <div className="filters">
            <span className="filter-label">Agent</span>
            <Link href={qs({ agent: undefined })} className={`chip ${agent ? "" : "on"}`}>
              all
            </Link>
            {agents
              .filter((a) => !project || !a.project || a.project === project)
              .map((a) => (
                <Link
                  key={a.id}
                  href={qs({ agent: a.id })}
                  className={`chip ${agent === a.id ? "on" : ""}`}
                  title={a.name}
                >
                  {a.id}
                </Link>
              ))}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: the <search> element is not styled here; role="search" on the form is the established pattern */}
          <form className="search" action="/" method="get" role="search">
            {agent && <input type="hidden" name="agent" value={agent} />}
            {project && <input type="hidden" name="project" value={project} />}
            {schedule && <input type="hidden" name="schedule" value={schedule} />}
            {outcome && <input type="hidden" name="outcome" value={outcome} />}
            {reason && <input type="hidden" name="reason" value={reason} />}
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search prompts or paste a run id…"
              aria-label="Search runs"
            />
            <button type="submit" className="search-btn">
              Search
            </button>
            {q && (
              <Link href={qs({ q: undefined })} className="clear">
                × clear search
              </Link>
            )}
          </form>
        </div>
      </div>

      <section
        className="stats"
        aria-label={filtered ? "Statistics for the current filter" : "Statistics for all runs"}
      >
        <div className="stat">
          <div className="label">Running now</div>
          <div className={`value ${o.running ? "run" : ""}`}>{o.running}</div>
          <div className="sub">
            {o.running ? "agents working" : "idle"}
            {filtered ? " · in this filter" : ""}
          </div>
        </div>
        <div
          className="stat tile-link"
          title="Completed with nothing to review (no denial, context exhaustion or MCP mismatch), over all finished runs. clean + completed to review + failed = finished"
        >
          {/* The whole tile opens the trend (stretched link); the counts below stay filters, above it. */}
          <Link href={trendHref} className="stat-hit stretched">
            <div className="stat-head">
              <div className="label">Clean runs</div>
              <span className="tile-more">Trend →</span>
            </div>
            <div className="value">{fmtPct(o.clean, o.finished)}</div>
          </Link>
          <div className="sub">
            {(["clean", "completed_review", "failed"] as const).map((k, i) => (
              <span key={k}>
                {i > 0 && " · "}
                <Link
                  href={qs({ outcome: outcome === k ? undefined : k, reason: undefined, limit: undefined })}
                  className={outcome === k ? "on" : ""}
                  aria-current={outcome === k ? "true" : undefined}
                >
                  {fmtInt(outcomeCounts[k])} {OUTCOME_LABELS[k]}
                </Link>
              </span>
            ))}
          </div>
        </div>
        <Link
          href={qs({ outcome: reviewOn ? undefined : "needs_review", reason: undefined, limit: undefined })}
          className={`stat tile-link filter ${reviewOn ? "on" : ""}`}
          aria-current={reviewOn ? "true" : undefined}
          title={reviewOn ? "Show every run again" : "Show only the runs that need review"}
        >
          <div className="stat-head">
            <div className="label">Needs review</div>
            {reviewOn && <span className="filter-on">filter on ✕</span>}
          </div>
          <div className={`value ${o.needsReview ? "warn" : ""}`}>
            {fmtInt(o.needsReview)}
            <span className="today" title="Started since midnight UTC, the day the daily caps count">
              {fmtInt(o.needsReviewToday)} today
            </span>
          </div>
          {reviewOn ? (
            <div className="sub" title="Midnight UTC, the day the daily caps count">
              {fmtInt(o.needsReviewToday)} since midnight · {fmtInt(o.needsReview - o.needsReviewToday)} earlier · list
              filtered
            </div>
          ) : (
            <div className="sub">failed, timed out, out of budget or context, orphaned, or denied a tool</div>
          )}
        </Link>
        <div className="stat" title={spend.basis === "api" ? undefined : SUBSCRIPTION_TITLE}>
          <div className="label">{spend.heading}</div>
          {spend.basis === "mixed" ? (
            <>
              <div className="value">
                {fmtCost(o.cost.apiUsd)} <span className="today">billed</span>
              </div>
              <div className="value">
                {fmtCost(o.cost.subscriptionUsd)} <span className="today">API value</span>
              </div>
            </>
          ) : (
            <div className="value">{fmtCost(o.costUsd)}</div>
          )}
          <div className="sub">
            {spend.basis === "subscription" && (
              <>
                {spend.note}
                <br />
              </>
            )}
            {fmtSplit(o.cost24h, spend.basis)} in the last 24 h{filtered ? " · in this filter" : ""}
            {o.quotaHitsWeek > 0 && (
              <>
                <br />
                <span className="warn-text" title="Runs that ended on the provider's usage limit (provider_quota)">
                  {fmtInt(o.quotaHitsWeek)} {o.quotaHitsWeek === 1 ? "run" : "runs"} hit the usage limit this week
                  {o.quotaResetAt && ` · next reset ${fmtClock(o.quotaResetAt)}`}
                </span>
              </>
            )}
            {o.costGatesUsd > 0 && (
              <>
                <br />
                <span title="Schedule gate agents decide whether a tick has work; their runs are not in the counts, only here">
                  {fmtCost(o.costUsd - o.costGatesUsd)} on runs · {fmtCost(o.costGatesUsd)} on gates
                </span>
              </>
            )}
          </div>
        </div>
      </section>

      {running.length > 0 ? (
        <>
          <h2>
            Running <span className="count">{running.length}</span>
          </h2>
          <RunTable runs={running} emptyText="" />
        </>
      ) : (
        <h2>
          Running <span className="count">none right now</span>
        </h2>
      )}

      {reviewOn ? (
        <h2>
          Recent · needs review <span className="count">{fmtInt(total)}</span>
        </h2>
      ) : (
        <h2>
          Recent <span className="count">{recent.length}</span>
          {filtered && <span className="count">· filtered by {activeLabel}</span>}
        </h2>
      )}
      <RunTable
        ended
        runs={recent}
        emptyText={
          filtered
            ? "No runs match this filter."
            : "No runs yet. Start one with run_agent from Claude Desktop, Claude Code or the CLI."
        }
      />
      {(hasMore || (recent.length > 0 && exactTotal !== null)) && (
        <div className="more">
          <span>
            showing {fmtInt(recent.length + running.length)} of {fmtInt(total)} runs
          </span>
          {hasMore && limit < MAX_LIMIT && (
            <Link href={qs({ limit: String(Math.min(limit * 2, MAX_LIMIT)) })}>load older runs →</Link>
          )}
          {hasMore && limit >= MAX_LIMIT && (
            <span className="faint">
              the dashboard lists at most {MAX_LIMIT}; use list_runs or the CLI for the rest
            </span>
          )}
        </div>
      )}

      {models.length > 1 && (
        <>
          <h2>
            By model{" "}
            <span className="count">
              all runs{modelWords.basis === "subscription" ? ` · API value, ${modelWords.note}` : ""}
            </span>
          </h2>
          <div className="card model-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Runs</th>
                  <th className="num">Avg duration</th>
                  <th className="num">Avg {modelWords.column === "Cost" ? "cost" : modelWords.column}</th>
                  <th className="num">Total</th>
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
                    <td className="num">{m.runs}</td>
                    <td className="num">{fmtDuration(m.avgDurationMs)}</td>
                    <td className="num">{fmtCost(m.avgCostUsd)}</td>
                    <td className="num">{fmtSplit(m.cost, modelWords.basis)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>All models</td>
                  <td className="num">{models.reduce((n, m) => n + m.runs, 0)}</td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num">{fmtSplit(modelCost, modelWords.basis)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}
