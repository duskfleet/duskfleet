import { wrapUpPhase } from "@duskfleet/core";
import Link from "next/link";
import type { RunWithProject } from "@/lib/data";
import { elapsedSince, fmtCost, fmtDuration, fmtRelative, fmtTime, runTitle, shortModel } from "@/lib/format";
import { RunRow } from "./RunRow";
import { StatusBadge } from "./StatusBadge";

/**
 * One row per run, the whole row a link. The short title (first line of the
 * prompt) is the identity of a run; agent, project and model are secondary.
 * Counters that only matter when debugging (turns, tool calls, tokens) live on
 * the detail page. Columns marked col-* collapse on narrow screens.
 */
export function RunTable({ runs, emptyText }: { runs: RunWithProject[]; emptyText: string }) {
  if (runs.length === 0) return <div className="empty">{emptyText}</div>;
  return (
    <table className="runs">
      <thead>
        <tr>
          <th>Status</th>
          <th>Run</th>
          <th className="col-model">Model</th>
          <th className="num col-duration">Duration</th>
          <th className="num">Cost</th>
          <th className="col-started">Started</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const duration = r.status === "running" ? elapsedSince(r.startedAt) : r.durationMs;
          const started = r.startedAt ?? r.createdAt;
          const href = `/runs/${r.id}`;
          const issues = `${href}#issues`;
          // The flags are the stored review reasons; the rule itself lives in core.
          const reasons = r.reviewReasons;
          const budget = reasons.includes("budget_exhausted");
          const orphaned = reasons.includes("orphaned");
          const wrapUp = budget ? wrapUpPhase(r) : null;
          return (
            <RunRow key={r.id} href={href}>
              <td className="status">
                <StatusBadge run={r} />
              </td>
              <td className="what">
                <div className="prompt" title={r.prompt}>
                  <Link href={href}>{runTitle(r.prompt)}</Link>
                </div>
                <div className="where">
                  <Link href={`/?agent=${encodeURIComponent(r.agentId)}`}>{r.agentId}</Link>
                  <span className="sep">·</span>
                  <span title={r.projectPath}>{r.projectLabel}</span>
                  {(r.permissionDenials ?? 0) > 0 && (
                    <span className="flags">
                      <Link
                        href={issues}
                        className="flag warn badge-link"
                        title={
                          (r.deniedTools ?? [])
                            .map((d) => `${d.tool}${d.summary ? `: ${d.summary}` : ""}`)
                            .join("\n") || "A tool call was denied"
                        }
                      >
                        {r.permissionDenials} denied
                      </Link>
                    </span>
                  )}
                  {(r.mcp?.allowListedMissing ?? []).length > 0 && (
                    <span className="flags">
                      <Link
                        href={issues}
                        className="flag warn badge-link"
                        title={`Allow-listed but never mounted: ${r.mcp.allowListedMissing.join(", ")}`}
                      >
                        mcp mismatch
                      </Link>
                    </span>
                  )}
                  {r.contextExhausted && (
                    <span className="flags">
                      <Link href={issues} className="flag bad badge-link">
                        context exhausted
                      </Link>
                    </span>
                  )}
                  {budget && (
                    <span className="flags">
                      <Link
                        href={issues}
                        className="flag bad badge-link"
                        title={
                          wrapUp
                            ? "The main pass ran out of budget; a wrap-up pass recorded where it stopped"
                            : "The run ran out of budget mid-action and left no wrap-up trace"
                        }
                      >
                        budget exhausted{wrapUp ? " · wrapped up" : ""}
                      </Link>
                    </span>
                  )}
                  {orphaned && (
                    <span className="flags">
                      <Link href={issues} className="flag bad badge-link" title={r.error ?? undefined}>
                        orphaned
                      </Link>
                    </span>
                  )}
                  {r.error && r.status !== "completed" && !budget && !orphaned && (
                    <span className="flags">
                      <Link href={issues} className="flag bad badge-link" title={r.error}>
                        error
                      </Link>
                    </span>
                  )}
                </div>
              </td>
              <td className="col-model">
                <span className="pill model" title={r.modelUsed ?? r.modelRequested ?? "CLI default"}>
                  {shortModel(r.modelUsed ?? r.modelRequested)}
                </span>
              </td>
              <td className="num col-duration">{fmtDuration(duration)}</td>
              <td className="num">{fmtCost(r.costUsd)}</td>
              <td className="when col-started" title={fmtTime(started)}>
                {fmtRelative(started)}
              </td>
            </RunRow>
          );
        })}
      </tbody>
    </table>
  );
}
