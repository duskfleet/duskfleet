import { REVIEW_REASON_LABELS, type RunEvent, reviewReasons, wrapUpPhase } from "@duskfleet/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CopyButton } from "@/components/CopyButton";
import { Expandable } from "@/components/Expandable";
import { Prose } from "@/components/Prose";
import { StatusBadge } from "@/components/StatusBadge";
import { adjacentRuns, agentSummary, getRun, homeDir, projectLabel } from "@/lib/data";
import {
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

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = getRun(id);
  if (!data) notFound();
  const { run, events } = data;
  const home = homeDir();
  const live = run.status === "running" || run.status === "pending";
  const duration = live ? elapsedSince(run.startedAt) : run.durationMs;
  const denials = run.permissionDenials ?? 0;
  const mcpMissing = run.mcp?.allowListedMissing ?? [];
  const wrapUp = wrapUpPhase(run);
  const mainPhase = run.phases.find((p) => p.phase === "main") ?? null;
  const reasons = reviewReasons(run);
  const needsAttention = reasons.length > 0;
  const hasIssues = needsAttention || Boolean(run.error) || wrapUp !== null;
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
              <span className="faint">← older</span>
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
              <span className="faint">newer →</span>
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
              <a href="#issues" className="muted">
                see issues ↓
              </a>
            </>
          )}
        </div>
        {agentDescription && <p className="agent-desc">{agentDescription}</p>}
      </div>

      <div className="facts">
        <Fact label="Duration" value={fmtDuration(duration)} />
        <Fact label="Cost" value={fmtCost(run.costUsd)} />
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
          tone={denials > 0 ? "warn" : "neutral"}
        />
      </div>

      <div id="issues">
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
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {(run.deniedTools ?? []).map((d, i) => (
                    <li key={i}>
                      <code>{d.tool}</code>
                      {d.summary && <span className="muted"> {tildeText(d.summary, home)}</span>}
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
        {run.error && (
          <div className="callout bad">
            <span className="icon">×</span>
            <div>
              <strong>Error.</strong> {tildeText(run.error, home)}
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

          <h2>
            Timeline <span className="count">{events.length} events</span>
          </h2>
          <Timeline events={events} t0={t0} cwd={run.projectPath} home={home} denied={run.deniedTools ?? []} />
        </div>

        <div style={{ display: "grid", gap: 20 }}>
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
            <div className="cmd">
              <blockquote className="quote" style={{ flex: 1 }}>
                {run.prompt}
              </blockquote>
              <CopyButton text={run.prompt} />
            </div>
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
                <dt>model requested</dt>
                <dd className="mono">{run.modelRequested ?? "agent / CLI default"}</dd>
                <dt>created</dt>
                <dd>{fmtTime(run.createdAt)}</dd>
                <dt>started</dt>
                <dd>{fmtTime(run.startedAt)}</dd>
                <dt>ended</dt>
                <dd>{fmtTime(run.endedAt)}</dd>
                <dt>exit code</dt>
                <dd>{run.exitCode ?? "–"}</dd>
                <dt>termination</dt>
                <dd className="mono">{run.terminationReason ?? "–"}</dd>
                <dt>input tokens</dt>
                <dd>{fmtInt(run.inputTokens)}</dd>
                <dt>output tokens</dt>
                <dd>{fmtInt(run.outputTokens)}</dd>
                <dt>cache read</dt>
                <dd>{fmtInt(run.cacheReadTokens)}</dd>
                <dt>cache write</dt>
                <dd>{fmtInt(run.cacheCreationTokens)}</dd>
                <dt>mcp mounted</dt>
                <dd className="mono">
                  {run.mcp?.mounted?.length
                    ? run.mcp.mounted.map((m) => `${m.name} (${m.status})`).join(", ")
                    : "none reported"}
                </dd>
                <dt>mcp used</dt>
                <dd className="mono">{run.mcp?.used?.length ? run.mcp.used.join(", ") : "–"}</dd>
                <dt>log</dt>
                <dd className="mono" title={run.logPath ?? undefined}>
                  {tildePath(run.logPath, home)}
                </dd>
              </dl>
              <div>
                <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 6 }}>
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

function Fact({
  label,
  value,
  title,
  tone,
}: {
  label: string;
  value: string;
  title?: string;
  tone?: "ok" | "warn" | "bad" | "neutral";
}) {
  return (
    <div className="fact">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ""}`} title={title}>
        {value}
      </div>
    </div>
  );
}

// ---- timeline ---------------------------------------------------------------

interface Row {
  key: string;
  offsetMs: number;
  icon: string;
  iconCls: string;
  name: string;
  detail: string;
  mono: boolean;
  isStatus: boolean;
  denied: boolean;
  toolName: string | null;
}

type Entry = { kind: "row"; row: Row } | { kind: "group"; rows: Row[] };

const LEGEND: Array<{ cls: string; icon: string; label: string }> = [
  { cls: "read", icon: "read", label: "Read / Grep / Glob" },
  { cls: "edit", icon: "edit", label: "Edit / Write" },
  { cls: "sh", icon: "sh", label: "Bash" },
  { cls: "mcp", icon: "mcp", label: "MCP tool" },
  { cls: "status", icon: "◆", label: "status change" },
  { cls: "denied", icon: "✗", label: "denied call" },
];

function Timeline({
  events,
  t0,
  cwd,
  home,
  denied,
}: {
  events: RunEvent[];
  t0: number;
  cwd: string;
  home: string;
  denied: Array<{ tool: string; summary: string | null }>;
}) {
  const rows = markDenied(events.map(toRow(t0, cwd, home)), denied);
  if (rows.length === 0) return <div className="empty">No events recorded.</div>;
  const entries = groupRuns(rows);
  const used = new Set(rows.map((r) => (r.denied ? "denied" : r.iconCls)));
  return (
    <>
      <section className="legend" aria-label="Legend">
        {LEGEND.filter((l) => used.has(l.cls)).map((l) => (
          <span key={l.cls}>
            <span className={`ic ${l.cls}`}>{l.icon}</span>
            {l.label}
          </span>
        ))}
        <span className="faint">· click a line to see it in full</span>
      </section>
      <ul className="timeline">
        {entries.map((e, i) =>
          e.kind === "row" ? (
            <TimelineRow key={e.row.key} r={e.row} />
          ) : (
            <li key={`g${i}`} className="group">
              <details>
                <summary>
                  <span className="off">{fmtOffset(e.rows[0]!.offsetMs)}</span>
                  <span className={`ic ${e.rows[0]!.iconCls}`}>{e.rows[0]!.icon}</span>
                  <span className="name">
                    {e.rows[0]!.name} <span className="count-tag">×{e.rows.length}</span>
                  </span>
                  <span className="detail plain">
                    {fmtOffset(e.rows[0]!.offsetMs)} → {fmtOffset(e.rows[e.rows.length - 1]!.offsetMs)} ·{" "}
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
          ),
        )}
      </ul>
    </>
  );
}

function TimelineRow({ r }: { r: Row }) {
  return (
    <li
      id={`ev-${r.key}`}
      className={`${r.isStatus ? "status-row" : ""} ${r.denied ? "denied" : ""}`}
      title={r.denied ? "This call was denied: the tool is not in the agent's allowed_tools" : undefined}
    >
      <span className="off">{fmtOffset(r.offsetMs)}</span>
      <span className={`ic ${r.denied ? "denied" : r.iconCls}`}>{r.denied ? "✗" : r.icon}</span>
      <span className="name">
        {r.name}
        {r.denied && <span className="count-tag"> denied</span>}
      </span>
      <span
        className={`detail ${r.mono ? "" : "plain"}`}
        tabIndex={r.detail.length > 60 ? 0 : undefined}
        title={r.detail}
      >
        {r.detail}
      </span>
    </li>
  );
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

function toRow(t0: number, cwd: string, home: string) {
  return (e: RunEvent): Row => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const offsetMs = new Date(e.ts).getTime() - t0;
    const base = {
      key: String(e.id),
      offsetMs,
      mono: true,
      isStatus: false,
      denied: false,
      toolName: null as string | null,
    };
    switch (e.type) {
      case "status_change":
        return {
          ...base,
          icon: "◆",
          iconCls: "status",
          name: String(p["to"] ?? "status"),
          detail: p["from"] ? `from ${String(p["from"])}` : "run created",
          mono: false,
          isStatus: true,
        };
      case "init":
        return {
          ...base,
          icon: "▶",
          iconCls: "status",
          name: "session",
          detail: [
            p["model"] ? shortModel(String(p["model"])) : null,
            p["cliVersion"] ? `Claude Code ${String(p["cliVersion"])}` : null,
            p["tools"] !== undefined ? `${String(p["tools"])} tools` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          mono: false,
        };
      case "tool_use": {
        const name = String(p["name"] ?? "tool");
        const raw = typeof p["summary"] === "string" ? p["summary"] : "";
        // Paths inside the project read better relative to it; others relative to home.
        const summary = tildeText(raw.split(cwd.endsWith("/") ? cwd : cwd + "/").join(""), home);
        return {
          ...base,
          icon: toolIcon(name),
          iconCls: toolClass(name),
          name: shortToolName(name),
          detail: summary,
          toolName: name,
        };
      }
      case "error":
        return {
          ...base,
          icon: "×",
          iconCls: "err",
          name: "error",
          detail: tildeText(String(p["parseError"] ?? p["message"] ?? JSON.stringify(p)), home),
        };
      case "note":
        return {
          ...base,
          icon: "·",
          iconCls: "",
          name: "note",
          detail: tildeText(String(p["message"] ?? JSON.stringify(p)), home),
          mono: false,
        };
      case "phase": {
        const started = p["status"] === "started";
        const name = `${String(p["phase"] ?? "phase").replace("_", "-")} ${started ? "started" : "ended"}`;
        const detail = started
          ? [
              p["budgetUsd"] !== undefined ? `budget ${fmtCost(Number(p["budgetUsd"]))}` : null,
              p["mainCostUsd"] !== undefined ? `main pass spent ${fmtCost(Number(p["mainCostUsd"]))}` : null,
              p["reason"] ? String(p["reason"]) : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : [
              p["outcome"] ? String(p["outcome"]) : null,
              p["costUsd"] !== undefined ? fmtCost(Number(p["costUsd"])) : null,
              p["durationMs"] !== undefined ? fmtDuration(Number(p["durationMs"])) : null,
            ]
              .filter(Boolean)
              .join(" · ");
        return { ...base, icon: "◆", iconCls: "status", name, detail, mono: false, isStatus: true };
      }
      default:
        return { ...base, icon: "·", iconCls: "", name: String(e.type), detail: JSON.stringify(p) };
    }
  };
}

/** "mcp__claude_ai_Figma__get_screenshot" → "Figma · get_screenshot" */
function shortToolName(name: string): string {
  const m = /^mcp__(?:claude_ai_|plugin_)?(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]!.replace(/_/g, " ")} · ${m[2]}` : name;
}

function toolClass(name: string): string {
  if (name === "Bash") return "sh";
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") return "edit";
  if (name === "Read" || name === "Grep" || name === "Glob") return "read";
  if (name.startsWith("mcp__")) return "mcp";
  return "";
}

/** Readable type labels instead of 10px glyphs. */
function toolIcon(name: string): string {
  if (name === "Bash") return "sh";
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") return "edit";
  if (name === "Read" || name === "Grep" || name === "Glob") return "read";
  if (name.startsWith("mcp__")) return "mcp";
  return "tool";
}

function shellQuote(arg: string, max?: number): string {
  if (max && arg.length > max) arg = arg.slice(0, max - 3) + "...";
  return /[\s"'$`\\!*?#&|;<>()]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}
