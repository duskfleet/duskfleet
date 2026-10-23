import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RunTable } from "@/components/RunTable";
import { budgetAlerts, listAgents, listProjects, listRuns, listSchedules, modelStats, overview } from "@/lib/data";
import { fmtCost, fmtDayClock, fmtDuration, fmtInt, fmtPct, shortModel } from "@/lib/format";

export const dynamic = "force-dynamic";

type Search = { agent?: string; project?: string; schedule?: string; q?: string; limit?: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }) {
  const { agent, project } = await searchParams;
  const name = agent ? (listAgents().find((a) => a.id === agent)?.name ?? agent) : null;
  const parts = ["Runs", project, name].filter(Boolean);
  return { title: `${parts.join(" · ")} · DuskFleet` };
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const { agent, project, schedule } = sp;
  const q = sp.q?.trim() || undefined;
  const limit = Math.min(Math.max(Number(sp.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const projects = listProjects();
  const agents = listAgents();
  const projectPath = project ? projects.find((p) => p.id === project)?.path : undefined;
  const filter: { agentId?: string; projectPath?: string; scheduleId?: string; q?: string } = {};
  if (agent) filter.agentId = agent;
  if (projectPath) filter.projectPath = projectPath;
  if (schedule) filter.scheduleId = schedule;
  if (q) filter.q = q;
  const filtered = Boolean(agent || project || schedule || q);

  const qs = (next: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged: Search = { agent, project, schedule, q, ...next };
    for (const k of ["agent", "project", "schedule", "q", "limit"] as const) {
      const v = merged[k];
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return s ? `/?${s}` : "/";
  };

  const running = listRuns({ ...filter, status: "running", limit: 50 });
  const recent = listRuns({ ...filter, limit }).filter((r) => r.status !== "running");
  const o = overview(filter);
  const models = modelStats();
  const budgets = budgetAlerts();
  const agentName = agent ? (agents.find((a) => a.id === agent)?.name ?? agent) : null;
  const scheduleName = schedule ? (listSchedules().find((s) => s.id === schedule)?.name ?? schedule) : null;
  const activeLabel = [project, agentName, scheduleName ? `schedule "${scheduleName}"` : null, q ? `"${q}"` : null]
    .filter(Boolean)
    .join(" / ");
  // In-memory filters (schedule, q) count what they found, not the whole table.
  const total = schedule || q ? recent.length + running.length : o.total;
  const hasMore = !schedule && !q && recent.length >= limit && total > recent.length + running.length;

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
        const label = b.scope === "global" ? "Global budget" : `Budget of ${b.scope} ${b.scopeId}`;
        return (
          <div key={b.id} className={`callout ${spent && b.hardStop ? "bad" : "warn"}`} style={{ margin: "0 0 16px" }}>
            <span className="icon">!</span>
            <div>
              <strong>
                {label}: {fmtCost(b.spentUsd)} of {fmtCost(b.amountUsd)} this month ({b.percent}%).
              </strong>{" "}
              {spent
                ? b.hardStop
                  ? "Spent: new runs in this scope are refused and its schedules were paused until the month turns (UTC) or the budget is raised."
                  : "Spent; hard_stop is off, so runs still start."
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
          className="stat"
          title="Completed with nothing to review (no denial, context exhaustion or MCP mismatch), over all finished runs. clean + completed to review + failed = finished"
        >
          <div className="label">Clean runs</div>
          <div className="value">{fmtPct(o.clean, o.finished)}</div>
          <div className="sub">
            {fmtInt(o.clean)} clean · {fmtInt(o.completed - o.clean)} completed to review · {fmtInt(o.failed)} failed
          </div>
        </div>
        <div className="stat">
          <div className="label">Needs review</div>
          <div className={`value ${o.needsReview ? "warn" : ""}`}>{o.needsReview}</div>
          <div className="sub">failed, timed out, out of budget or context, orphaned, or denied a tool</div>
        </div>
        <div className="stat">
          <div className="label">Spent</div>
          <div className="value">{fmtCost(o.costUsd)}</div>
          <div className="sub">
            {fmtCost(o.costLast24hUsd)} in the last 24 h{filtered ? " · in this filter" : ""}
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

      <h2>
        Recent <span className="count">{recent.length}</span>
        {filtered && <span className="count">· filtered by {activeLabel}</span>}
      </h2>
      <RunTable
        ended
        runs={recent}
        emptyText={
          filtered
            ? "No runs match this filter."
            : "No runs yet. Start one with run_agent from Claude Desktop, Claude Code or the CLI."
        }
      />
      {(hasMore || (recent.length > 0 && !schedule && !q)) && (
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
            By model <span className="count">all runs</span>
          </h2>
          <div className="card model-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Runs</th>
                  <th className="num">Avg duration</th>
                  <th className="num">Avg cost</th>
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
                    <td className="num">{fmtCost(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>All models</td>
                  <td className="num">{models.reduce((n, m) => n + m.runs, 0)}</td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num">{fmtCost(models.reduce((n, m) => n + m.costUsd, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}
