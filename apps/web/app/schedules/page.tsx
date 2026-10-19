import { parseHolder, REVIEW_REASON_LABELS } from "@duskfleet/core";
import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { ScheduleActions } from "@/components/ScheduleActions";
import { StatusBadge } from "@/components/StatusBadge";
import { listSchedules, scheduleFirings, schedulerEnabled, schedulerLease } from "@/lib/data";
import { fmtCost, fmtRelative, fmtTime, runTitle } from "@/lib/format";

const HOLDER_LABEL: Record<string, string> = {
  serve: "service",
  mcp: "MCP host",
  cli: "CLI",
  unknown: "unknown process",
};

export const dynamic = "force-dynamic";

export const metadata = { title: "Schedules · DuskFleet" };

const OUTCOME_CLASS: Record<string, string> = {
  started: "completed",
  resumed: "completed",
  skipped_busy: "attention",
  skipped_disabled: "cancelled",
  error: "failed",
};

export default function SchedulesPage() {
  const schedules = listSchedules();
  const enabled = schedulerEnabled();
  const lease = schedulerLease();
  const leaseLive = lease ? new Date(lease.expiresAt).getTime() > Date.now() : false;
  const holder = lease && leaseLive ? parseHolder(lease.holder) : null;
  const holderLabel = holder ? (HOLDER_LABEL[holder.role] ?? holder.role) : null;
  const mcpOnly = enabled && holder !== null && holder.role !== "serve";
  const paused = schedules.filter((s) => !s.enabled);
  const example = schedules[0];
  const enableExample = example
    ? `update_schedule { "id": "${example.id}", "enabled": true }`
    : `update_schedule { "id": "<schedule id>", "enabled": true }`;
  const createExample = `create_schedule { "name": "nightly review", "agent_id": "reviewer", "project_id": "<project id>", "cron": "0 7 * * 1-5", "prompt": "…" }`;

  return (
    <>
      <div className="page-head">
        <h1>Schedules</h1>
        <span
          className="muted"
          style={{ fontSize: "0.86rem", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
        >
          <span
            className={`badge ${enabled ? (leaseLive ? "running" : "pending") : "failed"}`}
            title={
              enabled
                ? leaseLive && lease
                  ? `Lease held by ${lease.holder} (${holderLabel}, host:pid) until ${fmtTime(lease.expiresAt)}. Only the lease holder ticks.`
                  : "scheduler.enabled is true but no DuskFleet process holds the lease right now"
                : "scheduler.enabled: false in config/duskfleet.yaml"
            }
          >
            {enabled ? (leaseLive ? `ticking · ${holderLabel}` : "no process ticking") : "scheduler off"}
          </span>
          <span>run now, pause, resume, edit when, delete here · create over MCP, see below</span>
        </span>
      </div>

      {mcpOnly && (
        <div className="callout warn" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <div>
            <strong>Ticking from an {holderLabel} only.</strong> Schedules stop firing when Claude Desktop / Claude Code
            closes. To run them unattended install the service once: <code>npm run cli -- install-service</code>{" "}
            (launchd, systemd --user or Task Scheduler).
          </div>
        </div>
      )}

      {!enabled && (
        <div className="callout bad" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <div>
            <strong>Kill switch on.</strong> <code>scheduler.enabled: false</code> in <code>config/duskfleet.yaml</code>
            : nothing fires until it is set back to true.
          </div>
        </div>
      )}
      {enabled && !leaseLive && (
        <div className="callout warn" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <div>
            <strong>No DuskFleet process is ticking.</strong> Schedules fire only while the MCP server (Claude Desktop /
            Claude Code) or
            <code> duskfleet serve</code> is running. Install it as a service once with{" "}
            <code>npm run cli -- install-service</code>. Missed ticks are not caught up.
          </div>
        </div>
      )}
      {enabled && leaseLive && paused.length === schedules.length && schedules.length > 0 && (
        <div className="callout warn" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <div>
            <strong>All {schedules.length} schedules are paused.</strong> Nothing will fire. Each row shows when it was
            paused; press <strong>Resume</strong> on one, or from an MCP client send <code>{enableExample}</code>.
          </div>
        </div>
      )}

      {schedules.length === 0 ? (
        <div className="empty">
          No schedules yet. From Claude Desktop: &quot;create a duskfleet schedule named <em>app main hourly</em> for
          agent <em>app-main-agent</em>, cron <code>0 8-20 * * 1-5</code>, prompt …&quot;.
        </div>
      ) : (
        <table className="runs">
          <thead>
            <tr>
              <th>State</th>
              <th>Schedule</th>
              <th>When</th>
              <th className="col-started">Next</th>
              <th>Last tick</th>
              <th className="num">Fired</th>
              <th className="num">Skipped</th>
              <th className="num" title="Last 7 days: runs that found nothing to do, and what they cost">
                Idle · 7 d
              </th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => {
              const firings = scheduleFirings(s.id, 6);
              return (
                <tr key={s.id} id={s.id}>
                  <td className="status">
                    <span
                      className={`badge ${s.enabled ? "completed" : "cancelled"}`}
                      title={
                        s.enabled
                          ? `Enabled · created ${fmtTime(s.createdAt)}`
                          : `Paused ${fmtRelative(s.updatedAt)} (${fmtTime(s.updatedAt)}). Re-enable with update_schedule { "id": "${s.id}", "enabled": true }`
                      }
                    >
                      {s.enabled ? "enabled" : "paused"}
                    </span>
                    {!s.enabled && (
                      <div className="faint" style={{ fontSize: "0.8rem", marginTop: 4 }} title={fmtTime(s.updatedAt)}>
                        since {fmtRelative(s.updatedAt)}
                      </div>
                    )}
                    {s.runRequestedAt && (
                      <div style={{ marginTop: 4 }}>
                        <span
                          className="badge pending"
                          title={`Run requested ${fmtTime(s.runRequestedAt)}; the ticking process fires it on its next tick`}
                        >
                          run requested
                        </span>
                      </div>
                    )}
                    {s.willResumeRunId && (
                      <div style={{ marginTop: 4 }}>
                        <Link
                          href={`/runs/${s.willResumeRunId}`}
                          className="badge attention"
                          title={`on_failure: resume_once (${s.onFailureSource}): the next fire resumes the session of run ${s.willResumeRunId} instead of starting fresh. Once; a second failure is final.`}
                        >
                          next: resume
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="what">
                    <div className="prompt" title={s.prompt}>
                      {s.name}
                    </div>
                    <div className="where">
                      <Link href={`/?agent=${encodeURIComponent(s.agentId)}`}>{s.agentId}</Link>
                      {s.projectId && (
                        <>
                          <span className="sep">·</span>
                          <Link href={`/?project=${encodeURIComponent(s.projectId)}`}>{s.projectId}</Link>
                        </>
                      )}
                      {s.model && (
                        <>
                          <span className="sep">·</span>
                          <span className="pill model">{s.model}</span>
                        </>
                      )}
                      <span className="sep">·</span>
                      <Link href={`/?schedule=${encodeURIComponent(s.id)}`} title="Runs started by this schedule">
                        runs →
                      </Link>
                      {s.effectiveOnFailure === "resume_once" && (
                        <>
                          <span className="sep">·</span>
                          <span
                            className="muted"
                            title={`on_failure: resume_once from the ${s.onFailureSource}${s.resumeBudgetUsd !== null ? ` · resume budget $${s.resumeBudgetUsd}` : ""}: after a budget or timeout failure the next tick resumes the session once`}
                          >
                            resume once on failure
                          </span>
                        </>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: "0.8rem", marginTop: 4, maxWidth: 520 }} title={s.prompt}>
                      {runTitle(s.prompt, 90)}
                    </div>
                    <ScheduleActions
                      id={s.id}
                      name={s.name}
                      enabled={s.enabled}
                      cron={s.cron}
                      timeZone={s.timeZone}
                      runRequested={s.runRequestedAt !== null}
                    />
                  </td>
                  <td className="cron-cell">
                    <div>{s.cronHuman}</div>
                    <div className="mono muted" title={`cron "${s.cron}" evaluated in ${s.timeZone}`}>
                      {s.cron} · {s.timeZone}
                    </div>
                  </td>
                  <td
                    className="when col-started"
                    title={
                      s.enabled
                        ? fmtTime(s.nextRunAt)
                        : s.theoreticalNextAt
                          ? `Would next fire ${fmtTime(s.theoreticalNextAt)} if enabled`
                          : undefined
                    }
                  >
                    {s.enabled && s.nextRunAt ? (
                      inFuture(s.nextRunAt)
                    ) : s.enabled ? (
                      "–"
                    ) : (
                      <span>
                        paused
                        {s.theoreticalNextAt && (
                          <div className="faint" style={{ fontSize: "0.8rem" }}>
                            would be {inFuture(s.theoreticalNextAt)}
                          </div>
                        )}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.lastOutcome ? (
                      <div style={{ display: "grid", gap: 4 }}>
                        <span>
                          <span className={`badge ${OUTCOME_CLASS[s.lastOutcome] ?? "pending"}`}>
                            {s.lastOutcome.replace("_", " ")}
                          </span>{" "}
                          <span className="muted" style={{ fontSize: "0.8rem" }} title={fmtTime(s.lastFiredAt)}>
                            {fmtRelative(s.lastFiredAt)}
                          </span>
                        </span>
                        {s.lastRun ? (
                          <span
                            style={{
                              fontSize: "0.8rem",
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <Link href={`/runs/${s.lastRun.id}`}>last run →</Link>
                            <StatusBadge status={s.lastRun.status} reasons={s.lastRun.reviewReasons} />
                            {s.lastRun.needsReview && (
                              <Link
                                href={`/runs/${s.lastRun.id}#issues`}
                                className="muted"
                                title={`The run this schedule last started needs review: ${s.lastRun.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ")}`}
                              >
                                {s.lastRun.reviewReasons
                                  .map((r) => REVIEW_REASON_LABELS[r])
                                  .slice(0, 2)
                                  .join(" · ")}
                              </Link>
                            )}
                          </span>
                        ) : (
                          s.lastRunId && (
                            <Link href={`/runs/${s.lastRunId}`} style={{ fontSize: "0.8rem" }}>
                              last run →
                            </Link>
                          )
                        )}
                        {s.lastError && (
                          <span className="muted" style={{ fontSize: "0.8rem" }} title={s.lastError}>
                            {s.lastError.slice(0, 90)}
                          </span>
                        )}
                        {firings.length > 1 && (
                          <span
                            style={{ display: "flex", gap: 3 }}
                            title={firings.map((f) => `${f.outcome} ${fmtTime(f.firedAt)}`).join("\n")}
                          >
                            {firings.map((f) => (
                              <span
                                key={f.id}
                                className={`badge ${OUTCOME_CLASS[f.outcome] ?? "pending"}`}
                                style={{ padding: 0, width: 10, height: 10, borderRadius: 3 }}
                              />
                            ))}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="muted">{s.enabled ? "not yet" : "never"}</span>
                    )}
                  </td>
                  <td className="num">{s.fires}</td>
                  <td
                    className="num"
                    style={s.skips > 0 ? { color: "var(--warn)" } : undefined}
                    title={
                      s.skips > 0
                        ? "Ticks skipped because the agent or project was busy. Skips are never queued."
                        : undefined
                    }
                  >
                    {s.skips}
                  </td>
                  <td
                    className="num"
                    title={`Last ${s.idle7d.days} days: ${s.idle7d.ticks} ticks, ${s.idle7d.fires} fires, ${s.idle7d.runs} runs (${fmtCost(s.idle7d.costUsd)}). ${s.idle7d.noopRuns} reported no work (${fmtCost(s.idle7d.noopCostUsd)}), matched by ${s.idle7d.noopPattern}${s.noopPattern ? " (this schedule's noop_pattern)" : " (scheduler.noop_pattern)"}.${s.idle7d.noopPatternError ? ` Not counted: ${s.idle7d.noopPatternError}.` : ""}`}
                  >
                    {s.idle7d.runs === 0 ? (
                      <span className="faint">–</span>
                    ) : (
                      <div style={{ display: "grid", gap: 2 }}>
                        <span
                          style={
                            s.idle7d.noopRuns > 0 && s.idle7d.noopRuns * 2 >= s.idle7d.runs
                              ? { color: "var(--warn)" }
                              : undefined
                          }
                        >
                          {s.idle7d.noopRuns} / {s.idle7d.runs} no-op
                        </span>
                        <span className="muted" style={{ fontSize: "0.8rem" }}>
                          {fmtCost(s.idle7d.noopCostUsd)} of {fmtCost(s.idle7d.costUsd)}
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Manage schedules</h2>
      <div className="card howto">
        <div className="muted" style={{ fontSize: "0.9rem" }}>
          Each row has <strong>Run now</strong>, <strong>Pause / Resume</strong>, <strong>Edit when</strong> (cron and
          time zone) and <strong>Delete</strong>; they apply the same validation as the MCP tools and whichever process
          ticks picks the change up on its next tick. <strong>Run now</strong> fires once, outside the cron and even
          when paused, on the next tick of the process that holds the lease (so nothing happens while no process ticks);
          a busy agent or project is a skip. Creating a schedule and changing its agent, project, prompt or model still
          go through an MCP client (Claude Desktop, Claude Code): <code>create_schedule</code>,{" "}
          <code>update_schedule</code>; <code>run_schedule_now</code> fires immediately from there. The CLI lists them
          with <code>npm run cli -- schedules</code>.
        </div>
        <div className="two-col">
          <div>
            <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 6 }}>
              Resume a paused schedule
            </div>
            <div className="cmd">
              <pre className="block">{enableExample}</pre>
              <CopyButton text={enableExample} />
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 6 }}>
              Create one
            </div>
            <div className="cmd">
              <pre className="block">{createExample}</pre>
              <CopyButton text={createExample} />
            </div>
          </div>
        </div>
        <div className="side-note">
          Busy agent or project at tick time = <code>skipped busy</code>, never a queue. Missed ticks while no process
          runs are not caught up.
        </div>
      </div>
    </>
  );
}

function inFuture(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "due";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} h ${min % 60} min`;
  return `in ${Math.round(h / 24)} d`;
}
