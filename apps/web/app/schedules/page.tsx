import {
  DEFAULT_GATE_BUDGET_USD,
  DEFAULT_GATE_MARKER,
  parseHolder,
  REVIEW_REASON_LABELS,
  type RunSummary,
  type ScheduleOutcome,
} from "@duskfleet/core";
import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { ScheduleActions } from "@/components/ScheduleActions";
import { firingTotals, listSchedules, scheduleFiringsWithRuns, schedulerEnabled, schedulerLease } from "@/lib/data";
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

/** One square of the firing strip: how the run it started ended, or why it did not start. */
type Verdict =
  | "clean"
  | "review"
  | "failed"
  | "cancelled"
  | "running"
  | "busy"
  | "capped"
  | "budget"
  | "gate"
  | "skipped"
  | "paused"
  | "gone";

const VERDICT_LABEL: Record<Verdict, string> = {
  clean: "clean",
  review: "needs review",
  failed: "failed",
  cancelled: "cancelled",
  running: "running",
  busy: "skipped busy",
  capped: "skipped, daily cap",
  budget: "skipped, monthly budget spent",
  gate: "skipped by the gate",
  skipped: "skipped, scheduler off",
  paused: "auto-paused",
  gone: "run no longer recorded",
};

/** The run's stored review reasons decide amber, as everywhere else (RunManager wrote them when it ended). */
function verdictOf(outcome: ScheduleOutcome, run: RunSummary | null): Verdict {
  if (outcome === "skipped_busy") return "busy";
  if (outcome === "skipped_daily_cap") return "capped";
  if (outcome === "skipped_budget") return "budget";
  if (outcome === "skipped_gate") return "gate";
  if (outcome === "skipped_disabled") return "skipped";
  if (outcome === "auto_paused") return "paused";
  if (outcome === "error") return "failed";
  if (!run) return "gone";
  if (run.status === "pending" || run.status === "running") return "running";
  if (run.status === "cancelled") return "cancelled";
  if (run.status !== "completed") return "failed";
  return run.reviewReasons.length > 0 ? "review" : "clean";
}

export default function SchedulesPage() {
  const schedules = listSchedules();
  const enabled = schedulerEnabled();
  const lease = schedulerLease();
  const leaseLive = lease ? new Date(lease.expiresAt).getTime() > Date.now() : false;
  const holder = lease && leaseLive ? parseHolder(lease.holder) : null;
  const holderLabel = holder ? (HOLDER_LABEL[holder.role] ?? holder.role) : null;
  const mcpOnly = enabled && holder !== null && holder.role !== "serve";
  const paused = schedules.filter((s) => !s.enabled);
  const next = schedules
    .flatMap((s) => (s.enabled && s.nextRunAt ? [{ s, at: s.nextRunAt }] : []))
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  const week = firingTotals(7);
  const firingsBySchedule = scheduleFiringsWithRuns(
    schedules.map((s) => s.id),
    FIRINGS_SHOWN,
  );
  const groups = groupByProject(schedules);
  const enableExample = schedules[0]
    ? `update_schedule { "id": "${schedules[0].id}", "enabled": true }`
    : `update_schedule { "id": "<schedule id>", "enabled": true }`;
  const createExample = `create_schedule { "name": "nightly review", "agent_id": "reviewer", "project_id": "<project id>", "cron": "0 7 * * 1-5", "prompt": "…" }`;

  return (
    <>
      <div className="page-head">
        <h1>
          Schedules <span className="count">{schedules.length}</span>
        </h1>
        <span className="note">
          Created and edited over MCP (<code>create_schedule</code>) or the CLI.
        </span>
      </div>

      {mcpOnly && (
        <div className="callout warn" style={{ margin: "0 0 16px" }}>
          <span className="icon">!</span>
          <div>
            <strong>Ticking from an {holderLabel} only.</strong> Schedules stop firing when Claude Desktop / Claude Code
            closes. To run them unattended install the service once: <code>npm run cli -- install-service</code>{" "}
            (launchd, systemd --user or Task Scheduler).
          </div>
        </div>
      )}
      {!enabled && (
        <div className="callout bad" style={{ margin: "0 0 16px" }}>
          <span className="icon">!</span>
          <div>
            <strong>Kill switch on.</strong> Nothing fires until <code>scheduler.enabled</code> in{" "}
            <code>config/duskfleet.yaml</code> is set back to true.
          </div>
        </div>
      )}
      {enabled && !leaseLive && (
        <div className="callout warn" style={{ margin: "0 0 16px" }}>
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
        <div className="callout warn" style={{ margin: "0 0 16px" }}>
          <span className="icon">!</span>
          <div>
            <strong>All {schedules.length} schedules are paused.</strong> Nothing will fire. Press{" "}
            <strong>Resume</strong> on one, or from an MCP client send <code>{enableExample}</code>.
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
            <div className="value neutral" title="scheduler.enabled: false in config/duskfleet.yaml">
              paused
            </div>
          )}
        </div>
        <div className="cell">
          <div className="label">Lease holder</div>
          {holder && lease ? (
            <>
              <div className="value mono" title={`${lease.holder} (${holderLabel}). Only the lease holder ticks.`}>
                {holder.role}
                {holder.pid !== null && ` · pid ${holder.pid}`}
              </div>
              <div className="sub" title={fmtTime(lease.expiresAt)}>
                lease until {clock(lease.expiresAt, true)}, {inFuture(lease.expiresAt)}
              </div>
            </>
          ) : (
            <>
              <div className="value neutral">none</div>
              <div className="sub" title={lease ? fmtTime(lease.expiresAt) : undefined}>
                {lease
                  ? `last held by ${lease.holder.split("@")[0]}, expired ${fmtRelative(lease.expiresAt)}`
                  : "never held"}
              </div>
            </>
          )}
        </div>
        <div className="cell">
          <div className="label">Next firing</div>
          {next ? (
            <>
              <div className="value" title={fmtTime(next.at)}>
                {clock(next.at)}
              </div>
              <div className="sub">
                {scheduleTitle(next.s)}, {inFuture(next.at)}
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
          No schedules yet. From Claude Desktop: &quot;create a duskfleet schedule named <em>app main hourly</em> for
          agent <em>app-main-agent</em>, cron <code>0 8-20 * * 1-5</code>, prompt …&quot;.
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.projectId ?? "\u0000none"} className="sched-group">
              <h2>
                {g.projectId ? (
                  <Link href={`/?project=${encodeURIComponent(g.projectId)}`} title="Runs in this project">
                    {g.projectId}
                  </Link>
                ) : (
                  "no project"
                )}{" "}
                <span className="count">
                  {g.schedules.length}
                  {g.paused > 0 && ` · ${g.paused} paused`}
                </span>
              </h2>
              <div className="sched-list">
                {g.schedules.map((s) => {
                  const firings = (firingsBySchedule.get(s.id) ?? []).map((f) => ({
                    ...f,
                    verdict: verdictOf(f.outcome, f.run),
                  }));
                  const last = firings[0];
                  const strip = [...firings].reverse();
                  const empty = FIRINGS_SHOWN - strip.length;
                  const idle = s.idle7d;
                  const idleWarn = idle.noopRuns > 0 && idle.noopRuns * 2 >= idle.runs;
                  return (
                    <article key={s.id} id={s.id} className={`sched-card${s.enabled ? "" : " paused"}`}>
                      <div className="main">
                        <div className="title-row">
                          <h3>{s.name}</h3>
                          <span
                            className={`badge ${s.enabled ? "completed" : "cancelled"}`}
                            title={
                              s.enabled
                                ? `Enabled · created ${fmtTime(s.createdAt)}`
                                : `Paused · last changed ${fmtRelative(s.updatedAt)} (${fmtTime(s.updatedAt)}). Re-enable with update_schedule { "id": "${s.id}", "enabled": true }`
                            }
                          >
                            {s.enabled ? "enabled" : "paused"}
                          </span>
                          {!s.enabled && s.pausedReason && (
                            <span
                              className="badge attention"
                              title={`${s.pausedReason}${s.autoPausedAt ? ` · ${fmtTime(s.autoPausedAt)}` : ""}. Resume to fire again; only runs after this pause count towards the next streak (scheduler.auto_pause_after).`}
                            >
                              auto-paused
                            </span>
                          )}
                          {s.runRequestedAt && (
                            <span
                              className="badge pending"
                              title={`Run requested ${fmtTime(s.runRequestedAt)}; the ticking process fires it on its next tick`}
                            >
                              run requested
                            </span>
                          )}
                          {s.willResumeRunId && (
                            <Link
                              href={`/runs/${s.willResumeRunId}`}
                              className="badge attention"
                              title={`on_failure: resume_once (${s.onFailureSource}): the next fire resumes the session of run ${s.willResumeRunId} instead of starting fresh. Once; a second failure is final.`}
                            >
                              next: resume
                            </Link>
                          )}
                        </div>
                        <div className="meta">
                          <span className="cron-chip" title={`cron "${s.cron}" evaluated in ${s.timeZone}`}>
                            {s.cron}
                          </span>
                          <span title={s.timeZone}>{s.cronHuman}</span>
                          <span className="sep">·</span>
                          <Link className="agent" href={`/?agent=${encodeURIComponent(s.agentId)}`}>
                            {s.agentId}
                          </Link>
                          {s.model && (
                            <>
                              <span className="sep">·</span>
                              <span className="model">{s.model}</span>
                            </>
                          )}
                          {s.gate && (
                            <>
                              <span className="sep">·</span>
                              {s.gate.invalid !== undefined ? (
                                <span
                                  className="flag warn"
                                  title={`Stored gate is unusable: ${s.gate.invalid}. Every fire is an error until the gate is set again or cleared.`}
                                >
                                  gate: invalid
                                </span>
                              ) : (
                                <span
                                  title={
                                    s.gate.command !== undefined
                                      ? `Gate: \`${s.gate.command}\` runs in the project first; exit 0 runs, exit 1-125 skips, anything else is an error`
                                      : `Gate: agent ${s.gate.agent?.agentId} checks first ($${s.gate.agent?.budgetUsd ?? DEFAULT_GATE_BUDGET_USD} budget); "${s.gate.agent?.marker ?? DEFAULT_GATE_MARKER}" as the last line of its answer skips`
                                  }
                                >
                                  gate: {s.gate.command !== undefined ? "command" : `agent ${s.gate.agent?.agentId}`}
                                </span>
                              )}
                            </>
                          )}
                          {s.effectiveOnFailure === "resume_once" && (
                            <>
                              <span className="sep">·</span>
                              <span
                                title={`on_failure: resume_once from the ${s.onFailureSource}${s.resumeBudgetUsd !== null ? ` · resume budget $${s.resumeBudgetUsd}` : ""}: after a budget or timeout failure the next tick resumes the session once`}
                              >
                                resume once on failure
                              </span>
                            </>
                          )}
                        </div>
                        <blockquote title={s.prompt}>{runTitle(s.prompt, 220)}</blockquote>
                      </div>

                      <div className="firings">
                        <div className="label">Last {FIRINGS_SHOWN} firings · newest right</div>
                        <div className="squares">
                          {Array.from({ length: empty }, (_, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                            <span key={`none-${i}`} className="sq none" title="not fired" />
                          ))}
                          {strip.map((f) => {
                            const title = [
                              `${VERDICT_LABEL[f.verdict]} · ${fmtTime(f.firedAt)}`,
                              f.run && f.run.reviewReasons.length > 0
                                ? f.run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ")
                                : null,
                              f.run ? fmtCost(f.run.costUsd) : null,
                              f.error,
                            ]
                              .filter(Boolean)
                              .join("\n");
                            return f.run ? (
                              <Link
                                key={f.id}
                                href={`/runs/${f.run.id}`}
                                className={`sq ${f.verdict}`}
                                title={title}
                                aria-label={title}
                              />
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
                                <span
                                  className={`v ${last.verdict}`}
                                  title={
                                    last.run && last.run.reviewReasons.length > 0
                                      ? last.run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ")
                                      : (last.error ?? undefined)
                                  }
                                >
                                  {VERDICT_LABEL[last.verdict]}
                                </span>
                                , <span title={fmtTime(last.firedAt)}>{fmtRelative(last.firedAt)}</span>
                                {last.run?.costUsd != null && `, ${fmtCost(last.run.costUsd)}`}
                              </>
                            ) : (
                              "never fired"
                            )}
                            {!s.enabled && s.pausedReason && s.autoPausedAt ? (
                              <span title={`${s.pausedReason} · ${fmtTime(s.autoPausedAt)}`}>
                                {" "}
                                · auto-paused{" "}
                                {new Date(s.autoPausedAt).toLocaleDateString(undefined, {
                                  day: "numeric",
                                  month: "short",
                                })}
                              </span>
                            ) : (
                              !s.enabled && (
                                <span
                                  title={`${fmtTime(s.updatedAt)}. Firings, run now and edits also update this time, so it is not the pause date.`}
                                >
                                  {" "}
                                  · paused, last changed{" "}
                                  {new Date(s.updatedAt).toLocaleDateString(undefined, {
                                    day: "numeric",
                                    month: "short",
                                  })}
                                </span>
                              )
                            )}
                          </span>
                          <Link href={`/?schedule=${encodeURIComponent(s.id)}`} title="Runs started by this schedule">
                            all runs →
                          </Link>
                        </div>
                      </div>

                      <div className="foot">
                        <span className="faint foot-facts">
                          <span
                            title={
                              s.enabled
                                ? fmtTime(s.nextRunAt)
                                : s.theoreticalNextAt
                                  ? `Would next fire ${fmtTime(s.theoreticalNextAt)} if enabled`
                                  : undefined
                            }
                          >
                            {s.enabled
                              ? s.nextRunAt
                                ? `next ${clock(s.nextRunAt)}, ${inFuture(s.nextRunAt)}`
                                : "no next firing"
                              : s.theoreticalNextAt
                                ? `would fire ${inFuture(s.theoreticalNextAt)} if resumed`
                                : "paused"}
                          </span>
                          <span className="sep">·</span>
                          <span className="num">{s.fires} fired</span>
                          <span className="sep">·</span>
                          <span
                            className={`num${s.skips > 0 ? " skips" : ""}`}
                            title={
                              s.skips > 0
                                ? "Ticks skipped because the agent or project was busy. Skips are never queued."
                                : undefined
                            }
                          >
                            {s.skips} skipped
                          </span>
                          {idle.runs > 0 && (
                            <>
                              <span className="sep">·</span>
                              <span
                                className={`idle${idleWarn ? " warn" : ""}`}
                                title={`Last ${idle.days} days: ${idle.ticks} ticks, ${idle.fires} fires, ${idle.runs} runs (${fmtCost(idle.costUsd)}). ${idle.noopRuns} reported no work (${fmtCost(idle.noopCostUsd)}), matched by ${idle.noopPattern}${s.noopPattern ? " (this schedule's noop_pattern)" : " (scheduler.noop_pattern)"}.${idle.noopPatternError ? ` Not counted: ${idle.noopPatternError}.` : ""}`}
                              >
                                {idle.noopRuns} / {idle.runs} no-op in {idle.days} d, {fmtCost(idle.noopCostUsd)} of{" "}
                                {fmtCost(idle.costUsd)}
                              </span>
                            </>
                          )}
                          {idle.gateChecks > 0 && (
                            <>
                              <span className="sep">·</span>
                              <span
                                title={`Gate checked ${idle.gateChecks} ticks in ${idle.days} days, skipped ${idle.gateSkips}; spent on gates ${fmtCost(idle.gateCostUsd)} (not in the run cost)`}
                              >
                                gate {idle.gateSkips}/{idle.gateChecks} skipped, {fmtCost(idle.gateCostUsd)}
                              </span>
                            </>
                          )}
                          {s.lastError && (
                            <>
                              <span className="sep">·</span>
                              <span className="err" title={s.lastError}>
                                {s.lastError.slice(0, 90)}
                              </span>
                            </>
                          )}
                        </span>
                        <ScheduleActions
                          id={s.id}
                          name={s.name}
                          enabled={s.enabled}
                          cron={s.cron}
                          timeZone={s.timeZone}
                          runRequested={s.runRequestedAt !== null}
                        />
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}

          <div className="sched-legend">
            <span>
              <span className="sq clean" />
              clean
            </span>
            <span>
              <span className="sq review" />
              needs review
            </span>
            <span>
              <span className="sq failed" />
              failed
            </span>
            <span>
              <span className="sq running" />
              running
            </span>
            <span>
              <span className="sq busy" />
              skipped, busy
            </span>
            <span>
              <span className="sq gate" />
              skipped by the gate
            </span>
            <span>
              <span className="sq paused" />
              auto-paused
            </span>
            <span>
              <span className="sq none" />
              not fired
            </span>
            <span>
              <span className="sq cancelled" />
              cancelled
            </span>
            <span>
              <span className="sq gone" />
              run gone
            </span>
          </div>
        </>
      )}

      <details className="card sched-howto">
        <summary>Managing schedules</summary>
        <p className="muted">
          Each card has <strong>Run now</strong>, <strong>Pause / Resume</strong>, <strong>Edit when</strong> (cron and
          time zone) and <strong>Delete</strong>; they apply the same validation as the MCP tools.{" "}
          <strong>Run now</strong> does not start Claude from here: it marks the schedule, and the process that holds
          the lease fires it once on its next tick, outside the cron and even when paused (so nothing happens while no
          process ticks). A busy agent or project at tick time is a skip, never a queue, and missed ticks are not caught
          up. Creating a schedule and changing its agent, project, prompt, model, gate or on-failure policy go through
          an MCP client with <code>create_schedule</code> and <code>update_schedule</code>; from there{" "}
          <code>run_schedule_now</code> fires immediately. On the command line, <code>npm run cli -- schedules</code>{" "}
          lists them.
        </p>
        <div className="two-col">
          <div>
            <div className="faint sched-howto-label">Resume a paused schedule</div>
            <div className="cmd">
              <pre className="block">{enableExample}</pre>
              <CopyButton text={enableExample} />
            </div>
          </div>
          <div>
            <div className="faint sched-howto-label">Create one</div>
            <div className="cmd">
              <pre className="block">{createExample}</pre>
              <CopyButton text={createExample} />
            </div>
          </div>
        </div>
      </details>
    </>
  );
}

type ScheduleRow = ReturnType<typeof listSchedules>[number];

interface ProjectGroup {
  projectId: string | null;
  schedules: ScheduleRow[];
  paused: number;
}

/** Projects alphabetically by id, "no project" last; cards keep the order listSchedules() gave them. */
function groupByProject(schedules: ScheduleRow[]): ProjectGroup[] {
  const byProject = new Map<string | null, ScheduleRow[]>();
  for (const s of schedules) {
    // The project the schedule runs on: its own, else its agent's ("no project" = neither).
    const key = s.effectiveProjectId;
    const rows = byProject.get(key);
    if (rows) rows.push(s);
    else byProject.set(key, [s]);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([projectId, rows]) => ({ projectId, schedules: rows, paused: rows.filter((s) => !s.enabled).length }));
}

/** "project · name" where a schedule is named outside its project group (the status strip). */
function scheduleTitle(s: { effectiveProjectId: string | null; name: string }): string {
  return s.effectiveProjectId ? `${s.effectiveProjectId} · ${s.name}` : s.name;
}

/** "02:00" today, "Mon 07:30" later on; with seconds for the lease expiry. */
function clock(iso: string, seconds = false): string {
  const t = new Date(iso);
  const hm = t.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
  return t.toDateString() === new Date().toDateString()
    ? hm
    : `${t.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
}

function inFuture(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "due";
  if (diff < 60_000) return `in ${Math.round(diff / 1000)} s`;
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} h ${min % 60} min`;
  return `in ${Math.round(h / 24)} d`;
}
