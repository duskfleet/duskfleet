import { REVIEW_REASON_LABELS } from "@duskfleet/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentActions } from "@/components/AgentActions";
import { AgentRunNow } from "@/components/AgentRunNow";
import { AgentStatus } from "@/components/AgentStatus";
import { MultiSelect, type MultiSelectOption } from "@/components/MultiSelect";
import { RunTable } from "@/components/RunTable";
import { Spark } from "@/components/Spark";
import { agentState, cleanTone } from "@/lib/agents";
import {
  agentDetail,
  agentRecentRuns,
  agentReviewReasons,
  agentStats,
  agentWindows,
  bashAllowed,
  deniedBashSuggestions,
  homeDir,
  listSchedules,
  type RunBucket,
  scopeBudget,
} from "@/lib/data";
import { fmtClock, fmtCost, fmtInt, fmtPct, fmtTime, shortModel, tildePath } from "@/lib/format";

export const dynamic = "force-dynamic";

const DAYS = 30;
/** Allow-list chips shown before "+ N more". */
const MAX_TOOL_CHIPS = 8;
/** Prompt lines shown before "show the whole …". */
const EXCERPT_LINES = 6;
const RECENT = 5;

type Params = { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string | string[] }> };

/** Recent runs Status filter: a partition of the runs by how they ended (stored review verdict, in SQL). */
const BUCKETS: ReadonlyArray<{ value: RunBucket; label: string }> = [
  { value: "running", label: "running" },
  { value: "review", label: "needs review" },
  { value: "clean", label: "completed" },
  { value: "cancelled", label: "cancelled" },
];

export async function generateMetadata({ params }: Params) {
  const { id } = await params;
  return { title: `${decodeURIComponent(id)} · Agents · Duskfleet` };
}

export default async function AgentPage({ params, searchParams }: Params) {
  const id = decodeURIComponent((await params).id);
  const sp = await searchParams;
  const d = agentDetail(id);
  if (!d) notFound();
  const { agent: a, project } = d;
  const s = agentStats().find((x) => x.agentId === id);
  const w = agentWindows(DAYS, id).get(id);
  const reasons = agentReviewReasons(id, DAYS);
  const schedules = listSchedules().filter((x) => x.agentId === id);
  const budget = scopeBudget({ agentId: id });
  const home = homeDir();
  const suggestions = (deniedBashSuggestions(10).get(id) ?? []).filter((t) => !bashAllowed(a.allowedTools ?? [], t));
  const autoPaused = schedules.some((x) => !x.enabled && x.pausedReason && x.autoPausedAt);
  const state = agentState({
    running: (s?.running ?? 0) > 0,
    autoPaused,
    lastNeedsReview: s?.lastNeedsReview ?? false,
  });

  const statuses = (Array.isArray(sp.status) ? sp.status : [sp.status]).filter((v): v is RunBucket =>
    BUCKETS.some((b) => b.value === v),
  );
  const base = `/agents/${encodeURIComponent(id)}`;
  const statusHref = (list: string[]) => {
    const p = new URLSearchParams();
    for (const v of list) p.append("status", v);
    return p.size ? `${base}?${p}` : base;
  };
  const statusOptions: MultiSelectOption[] = BUCKETS.map((b) => ({
    value: b.value,
    label: b.label,
    href: statusHref(statuses.includes(b.value) ? statuses.filter((x) => x !== b.value) : [...statuses, b.value]),
  }));
  const recent = agentRecentRuns(id, statuses, RECENT);

  const runsHref = `/?agent=${encodeURIComponent(id)}`;
  const tone = w ? cleanTone(w.clean, w.finished) : "";
  const today = w?.runsByDay.at(-1) ?? 0;
  const allowed = a.allowedTools ?? [];
  const maxReason = Math.max(1, ...reasons.map((r) => r.count));
  const reasonTotal = w?.needsReview ?? 0;

  return (
    <>
      <nav className="ad-crumb" aria-label="Breadcrumb">
        <Link href="/agents">
          <span className="ad-back" aria-hidden="true">
            ←{" "}
          </span>
          Agents
        </Link>
        <span className="faint"> / </span>
        <span className="muted">{project ? `project ${project.id}` : "any project"}</span>
      </nav>

      <header className="ad-head">
        <div className="ad-title">
          <div className="ad-name-row">
            <h1 className="ad-name">{a.id}</h1>
            <span
              className={`ac-kind ${a.claudeAgent ? "link" : ""}`}
              title={
                a.claudeAgent
                  ? `Runs as the project's ${a.claudeAgent} (claude --agent)`
                  : "Persona written in Duskfleet"
              }
            >
              {a.claudeAgent ? "link" : "own"}
            </span>
            {a.source === "builtin" ? (
              <span
                className="ac-kind"
                title="Versioned in config/agents. To edit it here or via update_agent, move it to data/agents."
              >
                builtin
              </span>
            ) : a.overridesBuiltin ? (
              <span className="ac-kind" title="This user file replaces the builtin with the same id">
                user overrides builtin
              </span>
            ) : null}
            {a.isDefault && (
              <span className="ac-kind" title="default_agent in duskfleet.yaml">
                default
              </span>
            )}
            <AgentStatus state={state} />
          </div>
          <div className="ad-meta">
            {project ? (
              <Link href={`/?project=${encodeURIComponent(project.id)}`} title={tildePath(project.path, home)}>
                {project.id}
              </Link>
            ) : (
              <span className="muted">any project</span>
            )}
            <span className="sep">·</span>
            {a.effectiveModel ? (
              <span title={a.effectiveModel}>{shortModel(a.effectiveModel)}</span>
            ) : (
              <span
                className="warn-text"
                title="No model set: runs use the Claude Code default, which can be the most expensive model. Set one with update_agent."
              >
                model not set
              </span>
            )}
            <span className="sep">·</span>
            <code className="ad-file" title={a.sourcePath}>
              {a.fileLabel}
            </code>
          </div>
        </div>
        <div className="ad-actions">
          <AgentActions
            id={a.id}
            source={a.source}
            linked={a.claudeAgent ?? null}
            overridesBuiltin={a.overridesBuiltin}
            afterDelete="/agents"
          />
          <AgentRunNow
            schedules={schedules.map((x) => ({ id: x.id, name: x.name, requested: Boolean(x.runRequestedAt) }))}
          />
        </div>
      </header>

      <section className="stats ad-tiles" aria-label={`Last ${DAYS} days`}>
        <div className="stat">
          <div className="label">Runs · {DAYS} d</div>
          <div className="ad-tile-row">
            <div className="value">{fmtInt(w?.runs ?? 0)}</div>
            <Spark small values={w?.runsByDay ?? new Array(DAYS).fill(0)} today={state === "running" ? "live" : ""} />
          </div>
          <div className="sub">
            {((w?.runs ?? 0) / DAYS).toFixed(1)} a day · {today} today
          </div>
        </div>
        <div className="stat" title="Completed with nothing to review, over finished runs">
          <div className="label">Clean</div>
          <div className={`value ${tone}`}>{w ? fmtPct(w.clean, w.finished) : "–"}</div>
          <div className="sub">
            {w?.clean ?? 0} clean · {(w?.finished ?? 0) - (w?.clean ?? 0)} not
          </div>
        </div>
        <div className="stat">
          <div className="label">Cost · {DAYS} d</div>
          <div className="ad-tile-row">
            <div className="value">{fmtCost(w?.costUsd ?? 0)}</div>
            <Spark small values={w?.costByDay ?? new Array(DAYS).fill(0)} today="accent" />
          </div>
          <div className="sub">
            {fmtCost((w?.costUsd ?? 0) / DAYS)} a day
            {budget && ` · budget ${fmtBudget(budget.amountUsd)} / month`}
          </div>
        </div>
        <Link
          href={`${runsHref}&outcome=needs_review`}
          className="stat tile-link"
          title="Open the runs of this agent that need review"
        >
          <div className="stat-head">
            <div className="label">Needs review</div>
            <span className="tile-more">Runs →</span>
          </div>
          <div className={`value ${reasonTotal ? "warn" : ""}`}>{fmtInt(reasonTotal)}</div>
          <div className="sub">
            {w?.needsReviewToday ?? 0} since midnight UTC{reasons.length > 0 && " · reasons below"}
          </div>
        </Link>
      </section>

      <div className="ad-body">
        <div className="ad-main">
          {a.claudeAgent ? (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <h2>Link target</h2>
              </div>
              <dl className="kv ad-kv">
                <dt>runs as</dt>
                <dd>
                  <code>claude --agent {a.claudeAgent}</code>
                </dd>
                <dt>in project</dt>
                <dd>
                  {project ? (
                    <>
                      {project.id} · <code>{tildePath(project.path, home)}</code>
                    </>
                  ) : (
                    <span className="warn-text">no registered project</span>
                  )}
                </dd>
                <dt>persona</dt>
                <dd>
                  {a.linked?.found ? (
                    <>
                      <code>.claude/agents/{a.claudeAgent}.md</code>{" "}
                      <span className="muted">(in the repo; Duskfleet owns only the unattended envelope)</span>
                    </>
                  ) : (
                    <span className="warn-text">
                      missing .claude/agents/{a.claudeAgent}.md: run_agent will refuse to start it
                    </span>
                  )}
                </dd>
                {d.systemPrompt.trim() && (
                  <>
                    <dt>appended prompt</dt>
                    <dd title={d.systemPrompt}>
                      {d.systemPrompt.trim().length} chars of this file, appended to the persona
                    </dd>
                  </>
                )}
              </dl>
              {d.persona && <Excerpt text={d.persona} more="show the whole persona" />}
            </section>
          ) : (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <h2>System prompt</h2>
                <span className="count">{d.systemPrompt.trim().length} chars</span>
              </div>
              {d.systemPrompt.trim() ? (
                <Excerpt text={d.systemPrompt.trim()} more="show the whole prompt" />
              ) : (
                <p className="muted ad-note">Empty: runs get only Claude Code&apos;s defaults.</p>
              )}
            </section>
          )}

          <section className="ad-panel">
            <div className="ad-panel-head">
              <h2>
                Recent runs{" "}
                <span className="count">
                  {fmtInt(w?.runs ?? 0)} in {DAYS} days
                </span>
              </h2>
              <Link href={runsHref}>all runs of this agent →</Link>
            </div>
            <div className="ad-filter">
              <MultiSelect
                path={base}
                param="status"
                label="Status"
                noun="statuses"
                options={statusOptions}
                selected={statuses}
                clearHref={base}
                selectAllHref={statusHref(BUCKETS.map((b) => b.value))}
              />
            </div>
            <div className="ad-runs">
              <RunTable
                ended
                runs={recent}
                emptyText={statuses.length ? "No recent run matches this status." : "This agent has no runs yet."}
              />
            </div>
          </section>
        </div>

        <div className="ad-side">
          <section className="ad-panel">
            <div className="ad-panel-head">
              <h2>Configuration</h2>
            </div>
            <h3 className="ad-sub">Permissions</h3>
            <dl className="kv ad-kv">
              <dt>permission mode</dt>
              <dd>
                <code>{a.permissionMode}</code>
              </dd>
              <dt>allow-list · {allowed.length}</dt>
              <dd>
                {allowed.length ? (
                  <span className="ad-chips">
                    {allowed.slice(0, MAX_TOOL_CHIPS).map((t) => (
                      <code key={t} className="ac-tag" title={t}>
                        {t}
                      </code>
                    ))}
                    {allowed.length > MAX_TOOL_CHIPS && (
                      <details className="ad-more">
                        <summary>+ {allowed.length - MAX_TOOL_CHIPS} more</summary>
                        <span className="ad-chips">
                          {allowed.slice(MAX_TOOL_CHIPS).map((t) => (
                            <code key={t} className="ac-tag" title={t}>
                              {t}
                            </code>
                          ))}
                        </span>
                      </details>
                    )}
                  </span>
                ) : (
                  <span className="muted">none</span>
                )}
              </dd>
              {suggestions.length > 0 && (
                <>
                  <dt>denied lately</dt>
                  <dd className="ad-chips">
                    {suggestions.map((t) => (
                      <code
                        key={t}
                        className="ac-tag suggest"
                        title={`Denied in this agent's recent runs. Add ${t} to allowed_tools to let unattended runs use it.`}
                      >
                        + {t}?
                      </code>
                    ))}
                  </dd>
                </>
              )}
              <dt>disallowed</dt>
              <dd>{a.disallowedTools?.length ? <code>{a.disallowedTools.join(", ")}</code> : <Muted />}</dd>
              <dt>add_dirs</dt>
              <dd>
                {a.addDirs?.length ? <code>{a.addDirs.map((x) => tildePath(x, home)).join(", ")}</code> : <Muted />}
              </dd>
              <dt>env passthrough</dt>
              <dd>{a.envPassthrough?.length ? <code>{a.envPassthrough.join(", ")}</code> : <Muted />}</dd>
              <dt>MCP</dt>
              <dd>{a.inheritMcp ? "inherits the user's servers" : "none (strict)"}</dd>
            </dl>
            <h3 className="ad-sub ad-sub-rule">Limits</h3>
            {/* one <div> per limit: a key/value list when wide, a 2-column grid of cells on mobile */}
            <dl className="kv ad-kv ad-limits">
              <div>
                <dt>budget per run</dt>
                <dd>
                  {fmtCost(a.maxBudgetUsd)}
                  {a.ownBudgetUsd === null && <span className="muted"> (default)</span>}
                </dd>
              </div>
              <div>
                <dt>wrap-up</dt>
                <dd>{a.wrapUpReserveUsd > 0 ? `${fmtCost(a.wrapUpReserveUsd)} kept back` : "off"}</dd>
              </div>
              <div>
                <dt>timeout</dt>
                <dd>
                  {a.timeoutMinutes} min
                  {a.ownTimeoutMinutes === null && <span className="muted"> (default)</span>}
                </dd>
              </div>
              <div>
                <dt>isolated</dt>
                <dd>{a.isolated ? "yes (skips the project guard)" : "no (one run per checkout)"}</dd>
              </div>
              <div>
                <dt>max_concurrent</dt>
                <dd>{a.maxConcurrent}</dd>
              </div>
              <div>
                <dt>daily caps</dt>
                <dd>
                  {a.maxDailyRuns || a.maxDailyCostUsd
                    ? [
                        a.maxDailyRuns ? `${a.maxDailyRuns} runs` : null,
                        a.maxDailyCostUsd ? fmtBudget(a.maxDailyCostUsd) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "none"}
                </dd>
              </div>
              <div>
                <dt>monthly budget</dt>
                <dd>
                  {budget
                    ? `${fmtBudget(budget.amountUsd)} · ${budget.hardStop ? "hard stop" : "warn only"} · ${budget.percent} % used`
                    : "none"}
                </dd>
              </div>
            </dl>
          </section>

          <section className="ad-panel">
            <div className="ad-panel-head">
              <h2>
                Schedules <span className="count">{schedules.length}</span>
              </h2>
              {schedules.length > 0 && <Link href={`/schedules#${schedules[0]?.id}`}>open in Schedules →</Link>}
            </div>
            {schedules.length ? (
              <ul className="ad-scheds">
                {schedules.map((x) => (
                  <li key={x.id}>
                    <div>
                      <Link href={`/schedules#${x.id}`} className="ad-sched-name">
                        {x.name}
                      </Link>
                      <code className="ad-cron" title={x.cronHuman}>
                        {x.cron} · {x.timeZone}
                      </code>
                    </div>
                    <span className="muted ad-next" title={x.nextRunAt ? fmtTime(x.nextRunAt) : undefined}>
                      {!x.enabled
                        ? x.pausedReason && x.autoPausedAt
                          ? "paused · auto"
                          : "paused"
                        : x.nextRunAt
                          ? `next ${fmtClock(x.nextRunAt)}`
                          : "–"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted ad-note">No schedule runs this agent.</p>
            )}
          </section>

          <section className="ad-panel">
            <div className="ad-panel-head">
              <h2>
                Needs review reasons{" "}
                <span className="count">
                  {fmtInt(reasonTotal)} · {DAYS} days
                </span>
              </h2>
            </div>
            {reasons.length ? (
              <>
                <ul className="ad-reasons">
                  {reasons.map((r) => (
                    <li key={r.reason}>
                      <Link href={`${runsHref}&reason=${encodeURIComponent(r.reason)}`}>
                        <span className="ad-reason">{REVIEW_REASON_LABELS[r.reason] ?? r.reason}</span>
                        <span className="ad-track" aria-hidden="true">
                          <span className="ad-bar" style={{ width: `${(r.count / maxReason) * 100}%` }} />
                        </span>
                        <span className="ad-reason-n">{r.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="muted ad-note">Each bar opens Runs filtered by agent and reason.</p>
              </>
            ) : (
              <p className="muted ad-note">No run of this agent needed review in {DAYS} days.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

/** The first lines of a prompt; the rest expands in place (a <details>, no JS). */
function Excerpt({ text, more }: { text: string; more: string }) {
  const lines = text.split("\n");
  const head = lines.slice(0, EXCERPT_LINES).join("\n");
  const rest = lines.slice(EXCERPT_LINES).join("\n");
  return (
    <div className="ad-excerpt">
      <pre>{head}</pre>
      {rest.trim() && (
        <details>
          <summary>{more} ↓</summary>
          <pre>{rest}</pre>
        </details>
      )}
    </div>
  );
}

function Muted() {
  return <span className="muted">none</span>;
}

/** "$1", "$0.50". */
function fmtBudget(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}
