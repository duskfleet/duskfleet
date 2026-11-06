import { ProjectRow } from "@/components/ProjectRow";
import { ProjectsEmpty } from "@/components/ProjectsEmpty";
import { homeDir, monthSpend, projectSummaries, scopeBudget } from "@/lib/data";
import { fmtCost, fmtInt } from "@/lib/format";
import { lastRunNeedsReview } from "@/lib/projects";

export const dynamic = "force-dynamic";

export const metadata = { title: "Projects · Duskfleet" };

/** DS-30: one row per registered project, KPI tiles above; an empty card when none is registered. */
export default function ProjectsPage() {
  const projects = projectSummaries();
  const home = homeDir();

  const head = (
    <div className="page-head">
      <h1>
        Projects <span className="h1-count">{projects.length}</span>
      </h1>
      <span className="page-note">
        Registered in <code>data/projects.yaml</code>. Home paths show as <code>~/…</code>
      </span>
    </div>
  );

  if (projects.length === 0) {
    return (
      <>
        {head}
        <ProjectsEmpty />
      </>
    );
  }

  const bound = projects.filter((p) => p.agents.length > 0).length;
  const month = monthSpend();
  const budget = scopeBudget({});
  const review = projects.filter((p) => lastRunNeedsReview(p.lastRun)).length;

  return (
    <>
      {head}

      <section className="stats agents-kpis" aria-label="Projects">
        <div className="stat">
          <div className="label">Projects</div>
          <div className="value">{projects.length}</div>
          <div className="sub">
            {bound} with bound agents · {projects.length - bound} without
          </div>
        </div>
        <div className="stat">
          <div className="label">Runs this month</div>
          <div className="value">{fmtInt(month.runs)}</div>
          <div className="sub">UTC month, all projects</div>
        </div>
        <div className="stat">
          <div className="label">Spent this month</div>
          <div className="value">{fmtCost(month.costUsd)}</div>
          {budget && <div className="sub">of {fmtCost(budget.amountUsd)} global budget</div>}
        </div>
        <div className="stat">
          <div className="label">Needs review</div>
          <div className={`value ${review ? "warn" : ""}`}>{review}</div>
          <div className="sub">{review === 1 ? "project whose" : "projects whose"} last run needs review</div>
        </div>
      </section>

      <table className="project-table">
        <thead>
          <tr>
            <th className="c-project">Project</th>
            <th className="c-agents">Bound agents</th>
            <th className="c-last">Last run</th>
            <th className="c-num">Runs this month</th>
            <th className="c-num">Spent this month</th>
            <th className="c-links">
              <span className="sr-only">Links</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} home={home} />
          ))}
        </tbody>
      </table>
    </>
  );
}
