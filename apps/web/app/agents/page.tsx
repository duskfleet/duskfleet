import Link from "next/link";
import type { ReactNode } from "react";
import { AgentActions } from "@/components/AgentActions";
import { agentStats, listAgents, listProjects } from "@/lib/data";
import { fmtCompact, fmtCost, fmtDuration, fmtPct, fmtRelative, shortModel, shortPath } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Agents · DuskFleet" };

export default function AgentsPage() {
  const agents = listAgents();
  const stats = new Map(agentStats().map((s) => [s.agentId, s]));
  const projects = listProjects();
  const groups: Array<{
    key: string;
    title: string;
    subtitle: string | null;
    runsHref: string | null;
    agents: typeof agents;
  }> = [];
  // The general-purpose group first: it holds the default agent, the one most callers get.
  const general = agents.filter((a) => !a.project || !projects.some((p) => p.id === a.project));
  if (general.length)
    groups.push({
      key: "__any",
      title: "Any project",
      subtitle: "General-purpose: pass a project to run_agent",
      runsHref: null,
      agents: general,
    });
  for (const p of projects) {
    const mine = agents.filter((a) => a.project === p.id);
    if (mine.length)
      groups.push({
        key: p.id,
        title: p.id,
        subtitle: p.description ?? shortPath(p.path),
        runsHref: `/?project=${encodeURIComponent(p.id)}`,
        agents: mine,
      });
  }

  return (
    <>
      <div className="page-head">
        <h1>Agents</h1>
        <span className="muted" style={{ fontSize: "0.86rem" }}>
          Builtins in <code>config/agents/</code>, yours in <code>data/agents/</code> or via <code>create_agent</code>.
          Edits apply to the next run.
        </span>
      </div>

      {groups.map((g) => (
        <section key={g.key} style={{ marginBottom: 30 }}>
          <h2 style={{ marginTop: 0 }}>
            {g.title} <span className="count">{g.agents.length}</span>
            {g.key === "__any" && g.agents.some((a) => a.isDefault) && <span className="tag">includes default</span>}
            <span
              className="count"
              style={{ marginLeft: "auto", fontWeight: 400, display: "inline-flex", gap: 8, alignItems: "center" }}
            >
              {g.subtitle}
              {g.runsHref && (
                <Link href={g.runsHref} className="chip-link">
                  runs →
                </Link>
              )}
            </span>
          </h2>
          <div className="agents-grid">
            {g.agents.map((a) => {
              const s = stats.get(a.id);
              const avgCost = s && s.total > 0 ? s.costUsd / s.total : null;
              const allowed = a.allowedTools ?? [];
              const denied = a.disallowedTools ?? [];
              const mcpAllowed = allowed.filter((t) => t.startsWith("mcp__"));
              const bashAllowed = allowed.filter((t) => t.startsWith("Bash("));
              const otherAllowed = allowed.filter((t) => !t.startsWith("mcp__") && !t.startsWith("Bash("));
              const runsHref = `/?agent=${encodeURIComponent(a.id)}${a.project ? `&project=${encodeURIComponent(a.project)}` : ""}`;
              const modelTitle =
                a.modelSource === "agent"
                  ? a.linked?.model
                    ? `This file sets ${a.model}, overriding ${a.claudeAgent}'s own ${a.linked.model}. run_agent can still override it.`
                    : `Runs use ${a.model} unless run_agent overrides it`
                  : a.modelSource === "link"
                    ? `Inherited from ${a.claudeAgent}'s frontmatter (${a.linked?.path ?? ""}). Set model here to override it.`
                    : a.claudeAgent
                      ? `Neither this file nor ${a.claudeAgent} sets a model: runs use the Claude Code default, which can be the most expensive model.`
                      : "No model set: runs use the Claude Code default, which can be the most expensive model. Set one with update_agent.";
              return (
                <article className="agent-card" key={a.id} id={a.id}>
                  <header className="ac-head">
                    <div className="ac-id">
                      <div className="ac-name">
                        <Link href={runsHref} title={`Runs of ${a.name}`}>
                          {a.name}
                        </Link>
                        {a.isDefault && <span className="tag">default</span>}
                      </div>
                      <div className="ac-meta">
                        <code>{a.id}</code>
                        <span className="sep">·</span>
                        <span title={a.sourcePath}>{a.source === "user" ? "user agent" : "builtin"}</span>
                        {a.claudeAgent && (
                          <>
                            <span className="sep">·</span>
                            <span
                              className="ac-link"
                              style={a.linked && !a.linked.found ? { color: "var(--warn)" } : undefined}
                              title={
                                a.linked?.found
                                  ? `Runs as the project's .claude/agents/${a.claudeAgent}.md (claude --agent). This file adds only the unattended envelope.`
                                  : `The project defines no .claude/agents/${a.claudeAgent}.md: run_agent will refuse to start this agent.`
                              }
                            >
                              linked to {a.claudeAgent}
                              {a.linked && !a.linked.found && " (missing)"}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className={`ac-model ${a.effectiveModel ? "" : "unset"}`} title={modelTitle}>
                      <span className="l">model</span>
                      <span className="v" title={a.effectiveModel ?? undefined}>
                        {a.effectiveModel ? shortModel(a.effectiveModel) : "not set"}
                      </span>
                      {!a.effectiveModel && <span className="ac-model-from">CLI default · can be the priciest</span>}
                      {a.modelSource === "link" && <span className="ac-model-from">from {a.claudeAgent}</span>}
                      {a.modelSource === "agent" && a.linked?.model && (
                        <span className="ac-model-from" title={a.linked.model}>
                          overrides {shortModel(a.linked.model)}
                        </span>
                      )}
                      {a.effectiveModel && !a.effectiveModel.startsWith("claude-") && (
                        <span
                          className="ac-model-from"
                          title={
                            s?.lastModelUsed
                              ? `Alias resolved by Claude Code at run time; last run used ${s.lastModelUsed}`
                              : "An alias is resolved by Claude Code when the run starts"
                          }
                        >
                          {s?.lastModelUsed ? `= ${shortModel(s.lastModelUsed)}` : "alias, resolved at run time"}
                        </span>
                      )}
                      {a.effectiveModel &&
                        a.effectiveModel.startsWith("claude-") &&
                        s?.lastModelUsed &&
                        s.lastModelUsed !== a.effectiveModel && (
                          <span
                            className="ac-model-from"
                            title={`The last run used ${s.lastModelUsed} (model changed since, or run_agent overrode it)`}
                          >
                            last run: {shortModel(s.lastModelUsed)}
                          </span>
                        )}
                    </div>
                  </header>

                  <p className="ac-desc">{a.description || "No description."}</p>

                  {s && s.total > 0 ? (
                    <div className="ac-stats">
                      <Stat label="runs" value={String(s.total)} />
                      <Stat label="success" value={fmtPct(s.completed, s.total)} />
                      <Stat label="avg cost" value={fmtCost(avgCost)} />
                      <Stat label="avg time" value={fmtDuration(s.avgDurationMs)} />
                      <Stat label="to review" value={String(s.needsReview)} tone={s.needsReview ? "warn" : undefined} />
                    </div>
                  ) : (
                    <div className="ac-norun">
                      <span>No runs yet.</span>
                      <code className="muted" style={{ fontSize: "0.8rem" }}>
                        run_agent {"{"} agent_id: &quot;{a.id}&quot; {"}"}
                      </code>
                    </div>
                  )}

                  <dl className="ac-caps">
                    <dt>permissions</dt>
                    <dd>
                      <span className="pill">{a.permissionMode}</span>
                      {denied.length > 0 && <span className="muted"> · no {denied.join(", ")}</span>}
                    </dd>
                    <dt>mcp</dt>
                    <dd>
                      {a.inheritMcp ? (
                        mcpAllowed.length ? (
                          <ChipList
                            items={mcpAllowed}
                            noun="MCP server"
                            render={(t) => t.replace(/^mcp__(claude_ai_|plugin_)?/, "")}
                          />
                        ) : (
                          <span style={{ color: "var(--warn)" }}>inherits servers but none allow-listed</span>
                        )
                      ) : (
                        <span className="muted">off</span>
                      )}
                    </dd>
                    <dt>shell</dt>
                    <dd>
                      {bashAllowed.length ? (
                        <ChipList
                          items={bashAllowed}
                          noun="shell command"
                          render={(t) => t.replace(/^Bash\((.*)\)$/, "$1").replace(/:\*$/, " …")}
                        />
                      ) : (
                        <span className="muted">
                          none
                          {a.permissionMode === "acceptEdits" || a.permissionMode === "dontAsk"
                            ? " (Bash is denied unless allow-listed)"
                            : ""}
                        </span>
                      )}
                    </dd>
                    {otherAllowed.length > 0 && (
                      <>
                        <dt>tools</dt>
                        <dd>
                          <ChipList items={otherAllowed} noun="tool" render={(t) => t} />
                        </dd>
                      </>
                    )}
                    <dt>limits</dt>
                    <dd className="muted">
                      {a.timeoutMinutes} min · {fmtCost(a.maxBudgetUsd)} per run
                      {a.wrapUpReserveUsd > 0 ? (
                        <span
                          title={`${fmtCost(a.wrapUpReserveUsd)} of the budget is kept for a wrap-up pass: when the main pass runs out, the session is resumed with it and told to record where it stopped (wrap_up_reserve_usd)`}
                        >
                          {" "}
                          · {fmtCost(a.wrapUpReserveUsd)} wrap-up reserve
                        </span>
                      ) : (
                        <span title="wrap_up_reserve_usd: 0 — a budget-exhausted run leaves no trace of where it stopped">
                          {" "}
                          · no wrap-up reserve
                        </span>
                      )}
                      {a.addDirs && a.addDirs.length > 0 && <> · also reads {a.addDirs.map(shortPath).join(", ")}</>}
                    </dd>
                  </dl>

                  <details className="ac-prompt">
                    <summary>
                      Show {a.claudeAgent ? "extra instructions" : "system prompt"}{" "}
                      <span className="faint">
                        ({fmtCompact(a.systemPromptLength)} chars{a.systemPromptLength > 400 ? ", first 400 shown" : ""}
                        )
                      </span>
                    </summary>
                    <pre className="block">{a.systemPromptPreview || "(empty)"}</pre>
                  </details>

                  <footer className="ac-foot">
                    <span className="muted">{s?.lastRunAt ? `last run ${fmtRelative(s.lastRunAt)}` : "never run"}</span>
                    <span className="ac-actions">
                      <Link href={runsHref} className="copy-btn" style={{ textDecoration: "none" }}>
                        Runs →
                      </Link>
                      <AgentActions id={a.id} source={a.source} linked={a.claudeAgent ?? null} />
                    </span>
                  </footer>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * Up to 4 entries inline; longer lists collapse to "N shell commands ▸" so a
 * card is not a wall of truncated chips. Every chip carries the full value
 * in its title.
 */
function ChipList({ items, noun, render }: { items: string[]; noun: string; render: (t: string) => ReactNode }) {
  const chips = (
    <span className="chips wrap">
      {items.map((t) => (
        <code key={t} className="chip" title={t}>
          {render(t)}
        </code>
      ))}
    </span>
  );
  if (items.length <= 4) return chips;
  return (
    <details className="caps">
      <summary>
        {items.length} {noun}s
      </summary>
      {chips}
    </details>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="ac-stat">
      <div className={`v ${tone ?? ""}`}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}
