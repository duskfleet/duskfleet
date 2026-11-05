import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { ProjectSummary } from "@/lib/data";
import { fmtAgo, fmtCost, fmtInt, fmtTime, tildePath } from "@/lib/format";
import { agentChips, agoText } from "@/lib/projects";

/**
 * DS-30 project row: name over its `~/…` path, bound agents as chips (two, then "+N"), the last
 * run as a `Project/LastRun` pill plus its age, this month's runs and spend, and "runs →" to the
 * Runs list filtered by the project. The pill is StatusBadge (stored review reasons: a completed
 * run that needs review is amber, never green); no run at all is the muted "none" pill.
 */
export function ProjectRow({ project: p, home, now }: { project: ProjectSummary; home: string; now?: number }) {
  const chips = agentChips(p.agents);
  const rest = p.agents.slice(chips.shown.length);
  return (
    <tr className="pr" id={p.id}>
      <td className="pr-project">
        <div className="pr-name">{p.id}</div>
        <code className="pr-path">{tildePath(p.path, home)}</code>
      </td>
      <td className="pr-agents">
        {p.agents.length === 0 ? (
          <span className="muted">no agent bound</span>
        ) : (
          <span className="pr-chips">
            {chips.shown.map((id) => (
              <Link key={id} href={`/agents/${encodeURIComponent(id)}`} className="ac-tag">
                {id}
              </Link>
            ))}
            {chips.more > 0 && (
              <span className="ac-tag" title={rest.join(", ")}>
                +{chips.more}
              </span>
            )}
          </span>
        )}
      </td>
      <td className="pr-last">
        {p.lastRun ? (
          <>
            <Link href={`/runs/${encodeURIComponent(p.lastRun.id)}`} className="badge-link">
              <StatusBadge run={p.lastRun} />
            </Link>
            <span className="pr-ago" title={fmtTime(p.lastRun.createdAt)}>
              {agoText(fmtAgo(p.lastRun.createdAt, now))}
            </span>
          </>
        ) : (
          <span className="badge none" title="No run on this project yet">
            none
          </span>
        )}
      </td>
      <td className="pr-num">{fmtInt(p.monthRuns)}</td>
      <td className="pr-num">{fmtCost(p.monthCostUsd)}</td>
      <td className="pr-links">
        <Link href={`/?project=${encodeURIComponent(p.id)}`}>runs →</Link>
      </td>
    </tr>
  );
}
