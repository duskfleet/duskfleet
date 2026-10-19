import Link from "next/link";
import type { RunWithProject } from "@/lib/data";
import {
  elapsedSince,
  fmtClock,
  fmtCost,
  fmtDuration,
  fmtInt,
  fmtRelative,
  fmtTime,
  runTitle,
  shortModel,
} from "@/lib/format";
import { RunRow } from "./RunRow";
import { StatusBadge } from "./StatusBadge";

/**
 * One row per run, the whole row a link. The short title (first line of the
 * prompt) is the identity of a run; agent, project and model are secondary.
 * Counters that only matter when debugging (turns, tool calls, tokens) live on
 * the detail page. Columns marked col-* collapse on narrow screens.
 *
 * `ended`: finished runs, so Duration / Ended (wall clock) instead of the live
 * Elapsed / Started (relative).
 */
export function RunTable({
  runs,
  emptyText,
  ended = false,
}: {
  runs: RunWithProject[];
  emptyText: string;
  ended?: boolean;
}) {
  if (runs.length === 0) return <div className="empty">{emptyText}</div>;
  return (
    <table className="runs">
      <thead>
        <tr>
          <th>Status</th>
          <th>Run</th>
          <th className="col-model">Model</th>
          <th className="num col-duration">{ended ? "Duration" : "Elapsed"}</th>
          <th className="num col-turns">Turns</th>
          <th className="num">Cost</th>
          <th className="col-started">{ended ? "Ended" : "Started"}</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const running = r.status === "running";
          const duration = running ? elapsedSince(r.startedAt) : r.durationMs;
          const started = r.startedAt ?? r.createdAt;
          const finished = r.endedAt ?? started;
          const href = `/runs/${r.id}`;
          const issues = `${href}#issues`;
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
                  {r.scheduleId && (
                    <span className="flags">
                      <Link href={`/schedules#${r.scheduleId}`} className="flag quiet badge-link" title={r.scheduleId}>
                        scheduled
                      </Link>
                    </span>
                  )}
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
                        {r.permissionDenials} {r.permissionDenials === 1 ? "denial" : "denials"}
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
                  {r.error && r.status !== "completed" && (
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
              <td className="num col-turns">{fmtInt(r.numTurns)}</td>
              <td className="num">{running ? "–" : fmtCost(r.costUsd)}</td>
              {ended ? (
                <td className="when col-started" title={fmtTime(finished)}>
                  {fmtClock(finished)}
                </td>
              ) : (
                <td className="when col-started" title={fmtTime(started)}>
                  {fmtRelative(started)}
                </td>
              )}
            </RunRow>
          );
        })}
      </tbody>
    </table>
  );
}
