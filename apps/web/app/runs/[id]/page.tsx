import { FAILURE_LABELS, REVIEW_REASON_LABELS, type Run, type RunEvent, wrapUpPhase } from "@duskfleet/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CopyButton } from "@/components/CopyButton";
import { Expandable } from "@/components/Expandable";
import { Prose } from "@/components/Prose";
import { StatusBadge } from "@/components/StatusBadge";
import { adjacentRuns, agentSummary, getRun, homeDir, projectLabel } from "@/lib/data";
import {
  billingNote,
  elapsedSince,
  fmtCompact,
  fmtCost,
  fmtDuration,
  fmtInt,
  fmtOffset,
  fmtRelative,
  fmtTime,
  runTitle,
  shortModel,
  tildePath,
  tildeText,
} from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = getRun(id);
  return { title: data ? `${runTitle(data.run.prompt, 60)} · DuskFleet` : "Run not found · DuskFleet" };
}

/** Timeline entries shown before "show all N events" (denials, errors and the result are always shown). */
const TIMELINE_LIMIT = 60;

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ events?: string }>;
}) {
  const { id } = await params;
  const showAll = (await searchParams).events === "all";
  const data = getRun(id);
  if (!data) notFound();
  const { run, events, resumedFrom, resumedBy } = data;
  const home = homeDir();
  const live = run.status === "running" || run.status === "pending";
  const duration = live ? elapsedSince(run.startedAt) : run.durationMs;
  const denials = run.permissionDenials ?? 0;
  const mcpMissing = run.mcp?.allowListedMissing ?? [];
  const wrapUp = wrapUpPhase(run);
  const mainPhase = run.phases.find((p) => p.phase === "main") ?? null;
  const reasons = run.reviewReasons; // stored by RunManager when the run ended
  const needsAttention = reasons.length > 0;
  const hasIssues = needsAttention || Boolean(run.error) || run.errorCode !== null || wrapUp !== null;
  const resume = run.claudeSessionId
    ? `cd ${shellQuote(run.projectPath)} && claude --resume ${run.claudeSessionId}`
    : null;
  const t0 = new Date(run.startedAt ?? run.createdAt).getTime();
  const fullCommand = `${run.command.binary} ${run.command.argv.map((a) => shellQuote(a, 160)).join(" ")}`;
  const again = [
    "npm run cli -- run",
    `--project ${shellQuote(run.projectPath)}`,
    `--agent ${run.agentId}`,
    run.modelRequested ? `--model ${run.modelRequested}` : null,
    `-- ${shellQuote(run.prompt)}`,
  ]
    .filter(Boolean)
    .join(" ");
  const { prev, next } = adjacentRuns(run);
  const project = projectLabel(run);
  // The agent as defined now; null when it was deleted or renamed since the run.
  const agent = agentSummary(run.agentId);
  const agentDescription = agent?.description ?? "";
  const started = run.startedAt ?? run.createdAt;
  const tokensIn = run.inputTokens ?? null;
  const tokensOut = run.outputTokens ?? null;
  // One row per event plus the closing result row; the header and "show all" count these.
  const rows = markDenied(events.map(toRow(run, t0, home)), run.deniedTools ?? []);
  const result = resultRow(run, t0);
  if (result) rows.push(result);

  return (
    <>
      {live && <AutoRefresh intervalMs={3000} />}
      <div className="run-head">
        <div className="crumbs">
          <Link href="/">Runs</Link>
          <span className="sep">/</span>
          <Link href={`/?agent=${encodeURIComponent(run.agentId)}`}>{run.agentId}</Link>
          <span className="sep">/</span>
          <span title={run.projectPath}>{project}</span>
          <span className="nav-runs">
            {prev ? (
              <Link
                href={`/runs/${prev.id}`}
                className="chip-link"
                title={`Previous run of ${run.agentId}: ${runTitle(prev.prompt, 60)}`}
              >
                ← older
              </Link>
            ) : (
              <span className="chip-link off">← older</span>
            )}
            {next ? (
              <Link
                href={`/runs/${next.id}`}
                className="chip-link"
                title={`Next run of ${run.agentId}: ${runTitle(next.prompt, 60)}`}
              >
                newer →
              </Link>
            ) : (
              <span className="chip-link off">newer →</span>
            )}
          </span>
        </div>
        <h1 title={run.prompt}>{runTitle(run.prompt, 110)}</h1>
        <div className="meta-row">
          <StatusBadge run={run} />
          <span className="sep">·</span>
          <Link
            href={`/agents#${encodeURIComponent(run.agentId)}`}
            title={
              agent
                ? `${agent.id}${agent.claudeAgent ? ` → ${agent.claudeAgent}` : ""}`
                : `${run.agentId} is no longer defined`
            }
          >
            {agent?.name ?? run.agentId}
          </Link>
          <span className="sep">·</span>
          <span title={run.projectPath}>{project}</span>
          <span className="sep">·</span>
          <span className="pill model" title={run.modelUsed ?? run.modelRequested ?? "CLI default"}>
            {shortModel(run.modelUsed ?? run.modelRequested)}
          </span>
          <span className="sep">·</span>
          <span title={fmtTime(started)}>{fmtRelative(started)}</span>
          {run.scheduleId && (
            <>
              <span className="sep">·</span>
              <Link href={`/schedules#${run.scheduleId}`} title={run.scheduleId}>
                scheduled
              </Link>
            </>
          )}
          {hasIssues && (
            <>
              <span className="sep">·</span>
              <a href="#issues" className="to-issues">
                see issues ↓
              </a>
            </>
          )}
        </div>
        {agentDescription && <p className="agent-desc">{agentDescription}</p>}
      </div>

      <div className="facts">
        <Fact label="Duration" value={fmtDuration(duration)} />
        <Fact
          label={run.billingType === "subscription" ? "Cost · reported, not billed" : "Cost"}
          value={fmtCost(run.costUsd)}
          title={billingNote(run.billingType) ?? undefined}
        />
        <Fact label="Turns" value={fmtInt(run.numTurns)} />
        <Fact label="Tool calls" value={fmtInt(run.toolCalls)} />
        <Fact
          label="Tokens in / out"
          value={
            tokensIn === null && tokensOut === null
              ? "–"
              : `${tokensIn === null ? "–" : fmtCompact(tokensIn)} / ${tokensOut === null ? "–" : fmtCompact(tokensOut)}`
          }
          title={`input ${fmtInt(tokensIn)} · output ${fmtInt(tokensOut)} · cache read ${fmtInt(run.cacheReadTokens)} · cache write ${fmtInt(run.cacheCreationTokens)}`}
        />
        <Fact
          label="Denials"
          value={live && run.permissionDenials === null ? "–" : String(denials)}
          tone={denials > 0 ? "warn" : undefined}
        />
      </div>

      <div id="issues">
        {resumedFrom && (
          <div className="callout warn">
            <span className="icon">↺</span>
            <div>
              <strong>Retry.</strong> This run resumed the session of{" "}
              <Link href={`/runs/${resumedFrom.id}`}>{runTitle(resumedFrom.prompt, 60)}</Link> (
              {resumedFrom.status.replace("_", " ")}
              {resumedFrom.terminationReason ? `, ${resumedFrom.terminationReason}` : ""}), once: a second failure is
              final (<code>on_failure: resume_once</code>).
            </div>
          </div>
        )}
        {resumedBy && (
          <div className="callout warn">
            <span className="icon">↺</span>
            <div>
              <strong>Retried.</strong> The next tick resumed this session as{" "}
              <Link href={`/runs/${resumedBy.id}`}>run {resumedBy.id.slice(0, 8)}</Link> (
              <StatusBadge run={resumedBy} />
              ). Check that run for the outcome.
            </div>
          </div>
        )}
        {needsAttention && (
          <div className="callout warn" style={{ marginBottom: 8 }}>
            <span className="icon">!</span>
            <div>
              <strong>Needs review:</strong> {reasons.map((r) => REVIEW_REASON_LABELS[r]).join(" · ")}.
              {run.status === "timed_out" && (
                <>
                  {" "}
                  The agent&apos;s <code>timeout_minutes</code> elapsed and the process was killed mid-action; nothing
                  may have been recorded.
                </>
              )}
              {reasons.includes("orphaned") && (
                <> DuskFleet restarted while the run was in progress; its process was lost.</>
              )}
              {reasons.includes("budget_exhausted") && !wrapUp && (
                <>
                  {" "}
                  The run hit <code>max_budget_usd</code> mid-action and no wrap-up pass ran (see{" "}
                  <code>wrap_up_reserve_usd</code>): whatever it was doing may be half-done and unrecorded.
                </>
              )}
            </div>
          </div>
        )}
        {denials > 0 && (
          <div className="callout warn">
            <span className="icon">!</span>
            <div>
              <strong>
                {denials} tool call{denials > 1 ? "s were" : " was"} denied.
              </strong>{" "}
              Unattended runs get no prompts, so anything outside the agent's <code>allowed_tools</code> is refused. Add
              the tool if it should have been permitted. The denied calls are{" "}
              <span className="flag warn">highlighted</span> in the timeline below.
              {(run.deniedTools ?? []).length > 0 && (
                <ul className="denied-calls">
                  {(run.deniedTools ?? []).map((d, i) => (
                    <li key={i}>
                      <code>{d.summary ? `${d.tool}(${tildeText(d.summary, home)})` : d.tool}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {mcpMissing.length > 0 && (
          <div className="callout warn">
            <span className="icon">!</span>
            <div>
              <strong>Allow-listed MCP server{mcpMissing.length > 1 ? "s" : ""} never mounted:</strong>{" "}
              {mcpMissing.map((p, i) => (
                <code key={i}>
                  {p}
                  {i < mcpMissing.length - 1 ? ", " : ""}
                </code>
              ))}
              . Mounted in this run:{" "}
              {run.mcp.mounted.length ? run.mcp.mounted.map((m) => m.name).join(", ") : "none reported"}
              {run.mcp.used.length ? <>; used: {run.mcp.used.join(", ")}</> : null}. The names differ (e.g.{" "}
              <code>mcp__plugin_*</code> vs <code>mcp__claude_ai_*</code>); fix the agent's <code>allowed_tools</code>.
            </div>
          </div>
        )}
        {run.contextExhausted && (
          <div className="callout bad">
            <span className="icon">!</span>
            <div>
              <strong>Context window exhausted.</strong> The run stopped before finishing. Split the task or give the
              agent a narrower prompt.
            </div>
          </div>
        )}
        {run.errorCode === "auth_required" && (
          <div className="callout bad">
            <span className="icon">!</span>
            <div>
              <strong>Claude is not logged in.</strong> Every run on this machine fails until it is: run{" "}
              <code>claude /login</code> in a terminal
              {run.errorDetail?.loginUrl ? (
                <>
                  {" "}
                  or open{" "}
                  <a href={run.errorDetail.loginUrl} target="_blank" rel="noreferrer">
                    the login page
                  </a>
                </>
              ) : null}
              , then run it again.
            </div>
          </div>
        )}
        {run.errorCode === "refusal" && !run.error && (
          <div className="callout warn">
            <span className="icon">!</span>
            <div>
              <strong>{FAILURE_LABELS.refusal}.</strong> The run ended with <code>stop_reason: refusal</code>: check the
              result before relying on it.
            </div>
          </div>
        )}
        {run.error && (
          <div className="callout bad">
            <span className="icon">×</span>
            <div>
              <strong>Error{run.errorCode ? `: ${FAILURE_LABELS[run.errorCode]}` : ""}.</strong>{" "}
              {run.errorDetail?.retryNotBefore ? <>Resets {fmtTime(run.errorDetail.retryNotBefore)}. </> : null}
              {tildeText(run.error, home)}
            </div>
          </div>
        )}
        {wrapUp && (
          <div className={`callout ${wrapUp.outcome === "completed" ? "warn" : "bad"}`}>
            <span className="icon">!</span>
            <div>
              <strong>
                Budget exhausted
                {mainPhase ? ` after ${fmtCost(mainPhase.costUsd)} of ${fmtCost(mainPhase.budgetUsd)}` : ""}.
              </strong>{" "}
              A wrap-up pass resumed the session with the {fmtCost(wrapUp.budgetUsd)} reserve and{" "}
              {wrapUp.outcome === "completed"
                ? "recorded where it stopped"
                : `ended ${wrapUp.outcome.replace("_", " ")}${wrapUp.terminationReason ? ` (${wrapUp.terminationReason})` : ""}`}
              : {fmtCost(wrapUp.costUsd)}, {fmtDuration(wrapUp.durationMs)}, {fmtInt(wrapUp.numTurns)} turn
              {wrapUp.numTurns === 1 ? "" : "s"}.
              {wrapUp.outcome === "completed"
                ? " Its final message is the result below; the task itself was not finished."
                : " The task was not finished and nothing may have been recorded: check the result and the place the agent reports to."}
            </div>
          </div>
        )}
      </div>

      <div className="two-col" style={{ marginTop: 24 }}>
        <div>
          <h2 style={{ marginTop: 0 }}>Result</h2>
          {run.resultText ? (
            run.resultText.length > 2500 ? (
              <Expandable>
                <Prose text={run.resultText} />
              </Expandable>
            ) : (
              <Prose text={run.resultText} />
            )
          ) : (
            <div className="prose quiet">
              {live ? "Working… the result appears here when the run finishes." : "The run produced no final text."}
            </div>
          )}

          <h2 id="timeline">
            Timeline <span className="count">{fmtInt(rows.length)} events</span>
          </h2>
          <Timeline run={run} rows={rows} limit={showAll ? null : TIMELINE_LIMIT} />
        </div>

        <div className="run-side">
          {resume && (
            <div>
              <h2 style={{ marginTop: 0 }}>Resume this session</h2>
              <div className="cmd">
                <pre className="block">{tildeText(resume, home)}</pre>
                <CopyButton text={resume} />
              </div>
            </div>
          )}

          <div>
            <h2 style={{ marginTop: 0 }}>Run again</h2>
            <div className="cmd">
              <pre className="block">{tildeText(again.length > 400 ? again.slice(0, 397) + "…" : again, home)}</pre>
              <CopyButton text={again} />
            </div>
            <div className="side-note">
              Same agent, project and prompt from a terminal in the repo. Or ask <code>run_agent</code> over MCP.
              {!run.modelRequested && " No model was pinned: the agent's or the CLI default applies."}
            </div>
          </div>

          <div>
            <h2 style={{ marginTop: 0 }}>
              Prompt <span className="count">{fmtInt(run.prompt.length)} chars</span>
            </h2>
            <blockquote className="quote">{run.prompt}</blockquote>
          </div>

          <details className="tech" open={needsAttention}>
            <summary>Technical details</summary>
            <div className="body">
              <dl className="kv">
                <dt>run id</dt>
                <dd className="mono">{run.id}</dd>
                <dt>session</dt>
                <dd className="mono">{run.claudeSessionId ?? "–"}</dd>
                <dt>project</dt>
                <dd className="mono" title={run.projectPath}>
                  {tildePath(run.projectPath, home)}
                </dd>
                <dt>permissions</dt>
                <dd className="mono">{run.permissionMode}</dd>
                <dt>model used</dt>
                <dd className="mono">{run.modelUsed ?? "–"}</dd>
                <dt>termination</dt>
                <dd className="mono">{run.terminationReason ?? "–"}</dd>
                <dt>cache read / write</dt>
                <dd className="num">
                  {fmtInt(run.cacheReadTokens)} / {fmtInt(run.cacheCreationTokens)}
                </dd>
                <dt>mcp mounted</dt>
                <dd className="mono">
                  {run.mcp?.mounted?.length
                    ? run.mcp.mounted.map((m) => `${m.name} (${m.status})`).join(", ")
                    : "none reported"}
                </dd>
                <dt>mcp used</dt>
                <dd className="mono">{run.mcp?.used?.length ? run.mcp.used.join(", ") : "–"}</dd>
                <dt>model requested</dt>
                <dd className="mono">{run.modelRequested ?? "agent / CLI default"}</dd>
                <dt>exit code</dt>
                <dd className="mono">{run.exitCode ?? "–"}</dd>
                <dt>started</dt>
                <dd>{fmtTime(started)}</dd>
                <dt>ended</dt>
                <dd>{fmtTime(run.endedAt)}</dd>
                <dt>log</dt>
                <dd className="mono" title={run.logPath ?? undefined}>
                  {tildePath(run.logPath, home)}
                </dd>
              </dl>
              <div>
                <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                  Exact command
                </div>
                <div className="cmd">
                  <pre className="block">{tildeText(fullCommand, home)}</pre>
                  <CopyButton text={fullCommand} />
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
    </>
  );
}

function Fact({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: Tone }) {
  return (
    <div className="fact">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ""}`} title={title}>
        {value}
      </div>
    </div>
  );
}

type Tone = "ok" | "warn" | "bad";

// ---- timeline ---------------------------------------------------------------

/** Type colours: tool calls sky, result green (amber when it needs review), errors coral, the rest muted. */
type Kind = "tool" | "muted" | Tone;

interface Row {
  key: string;
  offsetMs: number;
  /** Type column: "system", "Read", "Bash", "Figma", "result"… */
  name: string;
  kind: Kind;
  detail: string;
  mono: boolean;
  denied: boolean;
  toolName: string | null;
}

type Entry = { kind: "row"; row: Row } | { kind: "group"; rows: Row[] };
type Shown = Entry | { kind: "gap"; hidden: number };

function Timeline({ run, rows, limit }: { run: Run; rows: Row[]; limit: number | null }) {
  if (rows.length === 0) return <div className="empty">No events recorded.</div>;
  const entries = groupRuns(rows);
  const shown = capEntries(entries, limit);
  const truncated = shown.some((e) => e.kind === "gap");
  const showAll = `/runs/${run.id}?events=all#timeline`;
  return (
    <>
      <ul className="timeline">
        {shown.map((e, i) => {
          if (e.kind === "row") return <TimelineRow key={e.row.key} r={e.row} />;
          if (e.kind === "gap")
            return (
              <li key={`gap${i}`} className="skipped">
                <Link href={showAll} className="muted">
                  … {fmtInt(e.hidden)} more {e.hidden === 1 ? "entry" : "entries"}
                </Link>
              </li>
            );
          const first = e.rows[0] as Row;
          const last = e.rows[e.rows.length - 1] as Row;
          const span = fmtOffset(first.offsetMs) === fmtOffset(last.offsetMs) ? "" : ` → ${fmtOffset(last.offsetMs)}`;
          return (
            <li key={`g${first.key}`} className="group">
              <details>
                <summary>
                  <span className="off">{fmtOffset(first.offsetMs)}</span>
                  <span className={`name ${first.kind}`}>
                    {first.name} <span className="count-tag">×{e.rows.length}</span>
                  </span>
                  <span className="detail plain">
                    {fmtOffset(first.offsetMs)}
                    {span} ·{" "}
                    {e.rows
                      .map((r) => r.detail)
                      .filter(Boolean)
                      .slice(0, 3)
                      .join(", ")}
                    {e.rows.length > 3 ? ", …" : ""}
                  </span>
                </summary>
                <ul>
                  {e.rows.map((r) => (
                    <TimelineRow key={r.key} r={r} />
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
      <div className="timeline-foot">
        {truncated && (
          <>
            <Link href={showAll}>show all {fmtInt(rows.length)} events</Link>
            {run.logPath && <span className="sep">·</span>}
          </>
        )}
        {run.logPath && (
          <a href={`/runs/${run.id}/log`} target="_blank" rel="noreferrer">
            open the JSONL log
          </a>
        )}
      </div>
    </>
  );
}

function TimelineRow({ r }: { r: Row }) {
  return (
    <li
      id={`ev-${r.key}`}
      className={r.denied ? "denied" : undefined}
      title={r.denied ? "This call was denied: the tool is not in the agent's allowed_tools" : undefined}
    >
      <span className="off" title={`+${(Math.max(0, r.offsetMs) / 1000).toFixed(1)}s`}>
        {fmtOffset(r.offsetMs)}
      </span>
      <span className={`name ${r.denied ? "denied" : r.kind}`} title={r.toolName ?? undefined}>
        {r.name}
      </span>
      <span className="what">
        <span
          className={`detail ${r.mono ? "" : "plain"}`}
          tabIndex={r.detail.length > 60 ? 0 : undefined}
          title={r.detail}
        >
          {r.detail}
        </span>
        {r.denied && <span className="flag warn">denied</span>}
      </span>
    </li>
  );
}

/**
 * The first `limit` entries, plus every entry that must stay visible (denied calls,
 * errors, the result row) wherever it is; the hidden stretches become gap markers.
 */
function capEntries(entries: Entry[], limit: number | null): Shown[] {
  if (limit === null || entries.length <= limit) return entries;
  const pinned = (e: Entry) => e.kind === "row" && (e.row.denied || e.row.kind === "bad" || e.row.key === "result");
  const out: Shown[] = [];
  let hidden = 0;
  entries.forEach((e, i) => {
    if (i < limit || pinned(e)) {
      if (hidden > 0) out.push({ kind: "gap", hidden });
      hidden = 0;
      out.push(e);
    } else hidden++;
  });
  if (hidden > 0) out.push({ kind: "gap", hidden });
  return out;
}

/** The run's outcome as a closing row, once it has ended. Same verdict as the status badge. */
function resultRow(run: Run, t0: number): Row | null {
  if (!run.endedAt) return null;
  // the stored verdict, never the rule (see reviewReasons in core)
  const review = run.status === "completed" && run.reviewReasons.length > 0;
  const kind: Kind =
    run.status === "completed" ? (review ? "warn" : "ok") : run.status === "cancelled" ? "muted" : "bad";
  const detail = [
    review ? "needs review" : null,
    run.terminationReason ?? run.status,
    run.exitCode !== null && run.exitCode !== undefined ? `exit ${run.exitCode}` : null,
    run.costUsd !== null && run.costUsd !== undefined ? fmtCost(run.costUsd) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    key: "result",
    offsetMs: new Date(run.endedAt).getTime() - t0,
    name: "result",
    kind,
    detail,
    mono: false,
    denied: false,
    toolName: null,
  };
}

/** Consecutive calls of the same tool (3 or more, none denied) collapse into one expandable row. */
function groupRuns(rows: Row[]): Entry[] {
  const out: Entry[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    let j = i + 1;
    while (j < rows.length && r.toolName && rows[j]!.toolName === r.toolName && !rows[j]!.denied && !r.denied) j++;
    if (j - i >= 3) out.push({ kind: "group", rows: rows.slice(i, j) });
    else for (let k = i; k < j; k++) out.push({ kind: "row", row: rows[k]! });
    i = j;
  }
  return out;
}

/**
 * The stream reports denials only in the final result (tool name + argument
 * summary), not on the tool_use event itself. Match them back onto the
 * timeline: same tool and same summary; a denial without summary matches the
 * last unmatched call of that tool.
 */
function markDenied(rows: Row[], denied: Array<{ tool: string; summary: string | null }>): Row[] {
  if (denied.length === 0) return rows;
  const pending = [...denied];
  const out = rows.map((r) => ({ ...r }));
  for (const r of out) {
    if (!r.toolName) continue;
    const idx = pending.findIndex(
      (d) =>
        d.tool === r.toolName &&
        d.summary !== null &&
        r.detail !== "" &&
        (d.summary === r.detail || d.summary.endsWith(r.detail) || r.detail.endsWith(d.summary!)),
    );
    if (idx >= 0) {
      r.denied = true;
      pending.splice(idx, 1);
    }
  }
  for (const d of pending.filter((d) => d.summary === null)) {
    const r = [...out].reverse().find((x) => x.toolName === d.tool && !x.denied);
    if (r) r.denied = true;
  }
  return out;
}

function toRow(run: Run, t0: number, home: string) {
  const cwd = run.projectPath;
  return (e: RunEvent): Row => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const offsetMs = new Date(e.ts).getTime() - t0;
    const base = {
      key: String(e.id),
      offsetMs,
      kind: "muted" as Kind,
      mono: true,
      denied: false,
      toolName: null as string | null,
    };
    switch (e.type) {
      case "status_change":
        return {
          ...base,
          name: "status",
          detail: p["from"]
            ? `${String(p["from"])} → ${String(p["to"] ?? "?")}`
            : `${String(p["to"] ?? "?")} · run created`,
          mono: false,
        };
      case "init": {
        const servers = Array.isArray(p["mcpServers"]) ? (p["mcpServers"] as unknown[]).map(String) : null;
        const mounted = servers?.filter((s) => s.endsWith("(connected)")).length ?? 0;
        const detail = [
          "session started",
          p["model"] ? shortModel(String(p["model"])) : null,
          run.permissionMode,
          servers && servers.length > 0 ? `${mounted} MCP server${mounted === 1 ? "" : "s"} mounted` : null,
          p["cliVersion"] ? `Claude Code ${String(p["cliVersion"])}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return { ...base, name: "system", detail, mono: false };
      }
      case "tool_use": {
        const name = String(p["name"] ?? "tool");
        const raw = typeof p["summary"] === "string" ? p["summary"] : "";
        // Paths inside the project read better relative to it; others relative to home.
        const summary = tildeText(raw.split(cwd.endsWith("/") ? cwd : cwd + "/").join(""), home);
        // MCP tools: the server is the type, the tool name leads the detail.
        const m = /^mcp__(?:claude_ai_|plugin_)?(.+?)__(.+)$/.exec(name);
        if (!m) return { ...base, kind: "tool", name, detail: summary, toolName: name };
        const [, server = "", tool = ""] = m;
        return {
          ...base,
          kind: "tool",
          name: server.replace(/_/g, " "),
          detail: summary ? `${tool} ${summary}` : tool,
          toolName: name,
        };
      }
      case "error":
        return {
          ...base,
          kind: "bad",
          name: "error",
          detail: tildeText(String(p["parseError"] ?? p["message"] ?? JSON.stringify(p)), home),
        };
      case "note":
        return {
          ...base,
          name: "note",
          detail: tildeText(String(p["message"] ?? JSON.stringify(p)), home),
          mono: false,
        };
      case "phase": {
        const started = p["status"] === "started";
        const detail = started
          ? [
              "started",
              p["budgetUsd"] !== undefined ? `budget ${fmtCost(Number(p["budgetUsd"]))}` : null,
              p["mainCostUsd"] !== undefined ? `main pass spent ${fmtCost(Number(p["mainCostUsd"]))}` : null,
              p["reason"] ? String(p["reason"]) : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : [
              "ended",
              p["outcome"] ? String(p["outcome"]) : null,
              p["costUsd"] !== undefined ? fmtCost(Number(p["costUsd"])) : null,
              p["durationMs"] !== undefined ? fmtDuration(Number(p["durationMs"])) : null,
            ]
              .filter(Boolean)
              .join(" · ");
        return { ...base, name: String(p["phase"] ?? "phase").replace("_", "-"), detail, mono: false };
      }
      default:
        return { ...base, name: String(e.type), detail: JSON.stringify(p) };
    }
  };
}

function shellQuote(arg: string, max?: number): string {
  if (max && arg.length > max) arg = arg.slice(0, max - 3) + "...";
  return /[\s"'$`\\!*?#&|;<>()]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}
