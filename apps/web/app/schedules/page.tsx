import Link from "next/link";
import { parseHolder, type Run, type ScheduleOutcome } from "@duskfleet/core";
import { ScheduleActions } from "@/components/ScheduleActions";
import { needsReview } from "@/components/StatusBadge";
import { firingTotals, listSchedules, scheduleFiringsWithRuns, schedulerEnabled, schedulerLease, schedulerTickSeconds } from "@/lib/data";
import { fmtCost, fmtRelative, fmtTime, runTitle } from "@/lib/format";

const HOLDER_LABEL: Record<string, string> = {
  serve: "service",
  mcp: "MCP host",
  cli: "CLI",
  unknown: "unknown process",
};

export const dynamic = "force-dynamic";

export const metadata = { title: "Schedules · DuskFleet" };

const FIRINGS_SHOWN = 10;

/** One square of the firing strip: the verdict of the run it started, or why it did not start. */
type Verdict = "clean" | "review" | "failed" | "running" | "busy" | "skipped";

const VERDICT_LABEL: Record<Verdict, string> = {
  clean: "clean",
  review: "needs review",
  failed: "failed",
  running: "running",
  busy: "skipped busy",
  skipped: "skipped, scheduler off",
};

function verdictOf(outcome: ScheduleOutcome, run: Run | null): Verdict {
  if (outcome === "skipped_busy") return "busy";
  if (outcome === "skipped_disabled") return "skipped";
  if (outcome === "error" || !run) return "failed";
  if (run.status === "pending" || run.status === "running") return "running";
  if (run.status !== "completed") return "failed";
  return needsReview(run) ? "review" : "clean";
}

export default function SchedulesPage() {
  const schedules = listSchedules();
  const enabled = schedulerEnabled();
  const lease = schedulerLease();
  const leaseLive = lease ? new Date(lease.expiresAt).getTime() > Date.now() : false;
  const holder = lease && leaseLive ? parseHolder(lease.holder) : null;
  const holderLabel = holder ? HOLDER_LABEL[holder.role] ?? holder.role : null;
  // The holder renews every tick with a TTL of three ticks, so the last renewal is expiry minus 3 ticks.
  const renewedAt = lease ? new Date(new Date(lease.expiresAt).getTime() - 3 * schedulerTickSeconds() * 1000).toISOString() : null;
  const mcpOnly = enabled && holder !== null && holder.role !== "serve";
  const paused = schedules.filter((s) => !s.enabled);
  const next = schedules
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
  const week = firingTotals(7);
  const enableExample = schedules[0] ? `update_schedule { "id": "${schedules[0].id}", "enabled": true }` : `update_schedule { "id": "<schedule id>", "enabled": true }`;

  return (
    <>
      <div className="page-head">
        <h1>
          Schedules <span className="count">{schedules.length}</span>
        </h1>
        <span className="muted head-note">
          Created and edited over MCP (<code>create_schedule</code>) or the CLI.
        </span>
      </div>

      {mcpOnly && (
        <div className="callout warn" style={{ margin: "0 0 16px" }}>
          <span className="icon">!</span>
          <div>
            <strong>Ticking from an {holderLabel} only.</strong> Schedules stop firing when Claude Desktop / Claude Code closes. To run them
            unattended install the service once: <code>npm run cli -- install-service</code> (launchd, systemd --user or Task Scheduler).
          </div>
        </div>
      )}
      {!enabled && (
        <div className="callout bad" style={{ margin: "0 0 16px" }}>
          <span className="icon">!</span>
          <div><strong>Kill switch on.</strong> <code>scheduler.enabled: false</code> in <code>config/duskfleet.yaml</code>: nothing fires until it is set back to true.</div>
        </div>
      )}
      {enabled && !leaseLive && (
        <div className="callout warn" style={{ margin: "0 0 16px" }}>
          <span className="icon">!</span>
          <div>
            <strong>No DuskFleet process is ticking.</strong> Schedules fire only while the MCP server (Claude Desktop / Claude Code) or
            <code> duskfleet serve</code> is running. Install it as a service once with <code>npm run cli -- install-service</code>. Missed
            ticks are not caught up.
          </div>
        </div>
      )}
      {enabled && leaseLive && paused.length === schedules.length && schedules.length > 0 && (
        <div className="callout warn" style={{ margin: "0 0 16px" }}>
          <span className="icon">!</span>
          <div>
            <strong>All {schedules.length} schedules are paused.</strong> Nothing will fire. Press <strong>Resume</strong> on one, or from an MCP
            client send <code>{enableExample}</code>.
          </div>
        </div>
      )}

      <div className="sched-strip">
        <div className="cell">
          <div className="label">Scheduler</div>
          {enabled ? (
            <div className="value ok" title="scheduler.enabled in config/duskfleet.yaml">
              <span className="dot" />
              enabled
            </div>
          ) : (
            <div className="value neutral" title="scheduler.enabled: false in config/duskfleet.yaml">paused</div>
          )}
        </div>
        <div className="cell">
          <div className="label">Lease holder</div>
          {holder && lease ? (
            <>
              <div className="value mono" title={`${lease.holder} (${holderLabel}). Only the lease holder ticks; the lease expires ${fmtTime(lease.expiresAt)}.`}>
                {holder.role}
                {holder.pid !== null && ` · pid ${holder.pid}`}
              </div>
              <div className="sub">renewed {secondsAgo(renewedAt)}</div>
            </>
          ) : (
            <>
              <div className="value neutral">none</div>
              <div className="sub">{lease ? `last held by ${lease.holder.split("@")[0]}, ${secondsAgo(renewedAt)}` : "never held"}</div>
            </>
          )}
        </div>
        <div className="cell">
          <div className="label">Next firing</div>
          {next?.nextRunAt ? (
            <>
              <div className="value" title={fmtTime(next.nextRunAt)}>{clock(next.nextRunAt)}</div>
              <div className="sub">
                {scheduleTitle(next)}, {inFuture(next.nextRunAt)}
              </div>
            </>
          ) : (
            <>
              <div className="value neutral">–</div>
              <div className="sub">{schedules.length === 0 ? "no schedules" : "nothing enabled"}</div>
            </>
          )}
        </div>
        <div className="cell">
          <div className="label">Last 7 days</div>
          <div className="value">
            {week.started} fired <span className="aside">· {week.skippedBusy} skipped busy</span>
          </div>
        </div>
      </div>

      {schedules.length === 0 ? (
        <div className="empty">
          No schedules yet. From Claude Desktop: &quot;create a duskfleet schedule named <em>app main hourly</em> for agent <em>app-main-agent</em>,
          cron <code>0 8-20 * * 1-5</code>, prompt …&quot;.
        </div>
      ) : (
        <>
          <div className="sched-list">
            {schedules.map((s) => {
              const firings = scheduleFiringsWithRuns(s.id, FIRINGS_SHOWN).map((f) => ({ ...f, verdict: verdictOf(f.outcome, f.run) }));
              const last = firings[0];
              const strip = [...firings].reverse();
              const empty = FIRINGS_SHOWN - strip.length;
              return (
                <article key={s.id} id={s.id} className={`sched-card${s.enabled ? "" : " paused"}`}>
                  <div className="main">
                    <div className="title-row">
                      <h3>{scheduleTitle(s)}</h3>
                      <span
                        className={`badge ${s.enabled ? "completed" : "cancelled"}`}
                        title={s.enabled ? `Enabled · created ${fmtTime(s.createdAt)}` : `Paused ${fmtTime(s.updatedAt)}`}
                      >
                        {s.enabled ? "enabled" : "paused"}
                      </span>
                      {s.runRequestedAt && (
                        <span className="badge pending" title={`Run requested ${fmtTime(s.runRequestedAt)}; the ticking process fires it on its next tick`}>
                          run requested
                        </span>
                      )}
                    </div>
                    <div className="meta">
                      <span className="cron-chip" title={`cron "${s.cron}" evaluated in ${s.timeZone}`}>{s.cron}</span>
                      <span title={s.timeZone}>{s.cronHuman}</span>
                      <span className="sep">·</span>
                      <Link className="agent" href={`/?agent=${encodeURIComponent(s.agentId)}`}>{s.agentId}</Link>
                      {s.projectId && (
                        <>
                          <span className="sep">·</span>
                          <span>{s.projectId}</span>
                        </>
                      )}
                      {s.model && (
                        <>
                          <span className="sep">·</span>
                          <span className="model">{s.model}</span>
                        </>
                      )}
                    </div>
                    <blockquote title={s.prompt}>{runTitle(s.prompt, 220)}</blockquote>
                  </div>

                  <div className="firings">
                    <div className="label">Last {FIRINGS_SHOWN} firings · newest right</div>
                    <div className="squares">
                      {Array.from({ length: empty }, (_, i) => (
                        <span key={`none-${i}`} className="sq none" title="not fired" />
                      ))}
                      {strip.map((f) => {
                        const title = [`${VERDICT_LABEL[f.verdict]} · ${fmtTime(f.firedAt)}`, f.run ? fmtCost(f.run.costUsd) : null, f.error].filter(Boolean).join("\n");
                        return f.runId ? (
                          <Link key={f.id} href={`/runs/${f.runId}`} className={`sq ${f.verdict}`} title={title} aria-label={title} />
                        ) : (
                          <span key={f.id} className={`sq ${f.verdict}`} title={title} />
                        );
                      })}
                    </div>
                    <div className="last">
                      <span>
                        last:{" "}
                        {last ? (
                          <>
                            <span className={`v ${last.verdict}`} title={last.error ?? undefined}>
                              {VERDICT_LABEL[last.verdict]}
                            </span>
                            , <span title={fmtTime(last.firedAt)}>{fmtRelative(last.firedAt)}</span>
                            {last.run?.costUsd != null && `, ${fmtCost(last.run.costUsd)}`}
                          </>
                        ) : (
                          "never fired"
                        )}
                        {!s.enabled && (
                          <span title={fmtTime(s.updatedAt)}> · paused since {new Date(s.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                        )}
                      </span>
                      <Link href={`/?schedule=${encodeURIComponent(s.id)}`} title="Runs started by this schedule">all runs →</Link>
                    </div>
                  </div>

                  <div className="foot">
                    <span className="faint next" title={s.enabled ? fmtTime(s.nextRunAt) : s.theoreticalNextAt ? `Would next fire ${fmtTime(s.theoreticalNextAt)} if enabled` : undefined}>
                      {s.enabled
                        ? s.nextRunAt
                          ? `next ${clock(s.nextRunAt)}, ${inFuture(s.nextRunAt)}`
                          : "no next firing"
                        : s.theoreticalNextAt
                          ? `would fire ${inFuture(s.theoreticalNextAt)} if resumed`
                          : "paused"}
                    </span>
                    <ScheduleActions id={s.id} name={s.name} enabled={s.enabled} cron={s.cron} timeZone={s.timeZone} runRequested={s.runRequestedAt !== null} />
                  </div>
                </article>
              );
            })}
          </div>

          <div className="sched-legend">
            <span><span className="sq clean" />clean</span>
            <span><span className="sq review" />needs review</span>
            <span><span className="sq failed" />failed</span>
            <span><span className="sq busy" />skipped, busy</span>
            <span><span className="sq none" />not fired</span>
          </div>
        </>
      )}
    </>
  );
}

function scheduleTitle(s: { projectId: string | null; name: string }): string {
  return s.projectId ? `${s.projectId} · ${s.name}` : s.name;
}

/** "02:00" today, "Mon 07:30" later on. */
function clock(iso: string): string {
  const t = new Date(iso);
  const hm = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return t.toDateString() === new Date().toDateString() ? hm : `${t.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
}

function secondsAgo(iso: string | null): string {
  if (!iso) return "–";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s} s ago` : fmtRelative(iso);
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
