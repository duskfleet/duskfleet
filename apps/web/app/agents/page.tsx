import path from "node:path";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentActions } from "@/components/AgentActions";
import {
  type AgentStats,
  agentStats,
  bashAllowed,
  deniedBashSuggestions,
  homeDir,
  listAgents,
  listProjects,
  listSchedules,
  projectAgentsFor,
} from "@/lib/data";
import { fmtAgo, fmtCost, fmtPct, shortModel, tildePath } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Agents · DuskFleet" };

type Agent = ReturnType<typeof listAgents>[number];

/** Allowed tools shown as tags before the rest collapse into "+N". */
const MAX_TOOL_TAGS = 4;

export default function AgentsPage() {
  const agents = listAgents();
  const stats = new Map(agentStats().map((s) => [s.agentId, s]));
  const suggestions = deniedBashSuggestions(10);
  const schedulesByAgent = new Map<string, string[]>();
  for (const s of listSchedules()) schedulesByAgent.set(s.agentId, [...(schedulesByAgent.get(s.agentId) ?? []), s.id]);
  const projects = listProjects();
  const home = homeDir();

  const groups: Array<{ key: string; title: ReactNode; agents: Agent[] }> = [];
  // The general-purpose group first: it holds the default agent, the one most callers get.
  const general = agents.filter((a) => !a.project || !projects.some((p) => p.id === a.project));
  if (general.length)
    groups.push({
      key: "__any",
      title: (
        <>
          Any project <span className="count">{general.length}</span>
        </>
      ),
      agents: general,
    });
  for (const p of projects) {
    const mine = agents.filter((a) => a.project === p.id);
    if (!mine.length) continue;
    groups.push({
      key: p.id,
      title: (
        <>
          Project <code className="h2-id">{p.id}</code>
          <span className="count" title={p.description}>
            {mine.length} · {tildePath(p.path, home)}
          </span>
        </>
      ),
      agents: mine,
    });
  }

  // Agents a project defines in .claude/agents that no DuskFleet agent links to yet.
  const unlinked = projects.flatMap((p) =>
    projectAgentsFor(p.id)
      .filter((pa) => !agents.some((a) => a.project === p.id && a.claudeAgent === pa.name))
      .map((pa) => ({
        project: p.id,
        name: pa.name,
        file: path.relative(p.path, pa.path) || pa.path,
        description: pa.description,
      })),
  );

  return (
    <>
      <div className="page-head">
        <h1>
          Agents <span className="h1-count">{agents.length}</span>
        </h1>
        <span className="page-note">
          Edit the files, or ask <code>create_agent</code> over MCP. The dashboard only deletes and unlinks.
        </span>
      </div>

      {groups.map((g) => (
        <section key={g.key} className="agent-section">
          <h2>{g.title}</h2>
          <div className="agents-grid">
            {g.agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                stats={stats.get(a.id)}
                suggestions={(suggestions.get(a.id) ?? []).filter((t) => !bashAllowed(a.allowedTools ?? [], t))}
                scheduleIds={schedulesByAgent.get(a.id) ?? []}
                home={home}
              />
            ))}
          </div>
        </section>
      ))}

      {unlinked.length > 0 && (
        <section className="agent-section">
          <h2>
            Found in projects, not linked <span className="count">{unlinked.length}</span>
          </h2>
          <div className="unlinked">
            {unlinked.map((u) => (
              <div className="unlinked-row" key={`${u.project}/${u.name}`} title={u.description || undefined}>
                <code>
                  {u.project} · {u.file}
                </code>
                <span className="muted">
                  Ask <code>create_agent</code> with kind link to run it unattended.
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function AgentCard({
  agent: a,
  stats: s,
  suggestions,
  scheduleIds,
  home,
}: {
  agent: Agent;
  stats: AgentStats | undefined;
  suggestions: string[];
  scheduleIds: string[];
  home: string;
}) {
  const allowed = a.allowedTools ?? [];
  const denied = a.disallowedTools ?? [];
  const addDirs = a.addDirs ?? [];
  const readOnly = a.permissionMode === "plan" || (denied.includes("Edit") && denied.includes("Write"));
  const runsHref = `/?agent=${encodeURIComponent(a.id)}${a.project ? `&project=${encodeURIComponent(a.project)}` : ""}`;
  const avgCost = s && s.total > 0 ? s.costUsd / s.total : null;
  const cleanPct = s && s.finished > 0 ? (s.clean / s.finished) * 100 : null;
  const cleanTone = cleanPct === null ? "" : cleanPct >= 90 ? "ok" : cleanPct >= 60 ? "warn" : "bad";
  const mcpAllowed = allowed.filter((t) => t.startsWith("mcp__"));
  const tools = allowed.filter((t) => !t.startsWith("mcp__"));
  const shownTools = tools.slice(0, MAX_TOOL_TAGS);
  const hiddenTools = tools.slice(MAX_TOOL_TAGS);

  const modelTitle =
    a.modelSource === "agent"
      ? a.linked?.model
        ? `This file sets ${a.model}, overriding ${a.claudeAgent}'s own ${a.linked.model}. run_agent can still override it.`
        : `Runs use ${a.model} unless run_agent overrides it${s?.lastModelUsed ? `; last run used ${s.lastModelUsed}` : ""}`
      : a.modelSource === "link"
        ? `Inherited from ${a.claudeAgent}'s frontmatter (${a.linked?.path ?? ""}). Set model here to override it.`
        : "No model set: runs use the Claude Code default, which can be the most expensive model. Set one with update_agent.";

  let state: ReactNode;
  if (s && s.running > 0) state = <span className="badge running">running</span>;
  else if (s?.lastNeedsReview)
    state = (
      <Link
        href={runsHref}
        className="badge attention badge-link"
        title="The last finished run needs review (denial, exhausted context or budget, timeout, crash)"
      >
        last run needs review
      </Link>
    );
  else if (readOnly)
    state = (
      <span className="ac-state" title="Edit and Write are disallowed">
        read-only
      </span>
    );
  else state = <span className="ac-state">idle</span>;

  return (
    <article className="agent-card" id={a.id}>
      <header className="ac-head">
        <h3 className="ac-name" title={a.name !== a.id ? a.name : undefined}>
          {a.id}
        </h3>
        <span
          className={`ac-kind ${a.claudeAgent ? "link" : ""}`}
          title={
            a.claudeAgent ? `Runs as the project's ${a.claudeAgent} (claude --agent)` : "Persona written in DuskFleet"
          }
        >
          {a.claudeAgent ? "link" : "own"}
        </span>
        {a.source === "builtin" ? (
          <span
            className="flag quiet"
            title="Versioned in config/agents. To edit it here or via update_agent, move it to data/agents."
          >
            builtin
          </span>
        ) : a.overridesBuiltin ? (
          <span className="flag warn" title="This user file replaces the builtin with the same id">
            user · overrides builtin
          </span>
        ) : null}
        {a.isDefault && (
          <span className="flag quiet" title="default_agent in duskfleet.yaml">
            default
          </span>
        )}
        <span className="ac-state-slot">{state}</span>
      </header>

      <p
        className="ac-desc"
        title={
          !a.claudeAgent && a.systemPromptPreview
            ? `System prompt (${a.systemPromptLength} chars):\n${a.systemPromptPreview}`
            : undefined
        }
      >
        {a.description ||
          (a.claudeAgent ? (
            <>
              Runs <code>claude --agent {a.claudeAgent}</code> in the project. The persona lives in the repo; DuskFleet
              owns only the envelope.
            </>
          ) : (
            "No description."
          ))}
      </p>
      {a.linked?.description && a.linked.description !== a.description && (
        <p className="ac-desc ac-linked-desc" title={a.linked.path ?? undefined}>
          <span className="l">{a.claudeAgent} says</span> {a.linked.description}
        </p>
      )}

      <div className="ac-tags">
        {a.claudeAgent &&
          (a.linked?.found ? (
            <code className="ac-tag" title={a.linked.path ?? undefined}>
              .claude/agents/{a.claudeAgent}.md
            </code>
          ) : (
            <code className="ac-tag warn" title="The project defines no such agent: run_agent will refuse to start it">
              missing .claude/agents/{a.claudeAgent}.md
            </code>
          ))}
        {a.effectiveModel ? (
          <code className="ac-tag" title={modelTitle}>
            {shortModel(a.effectiveModel)}
          </code>
        ) : (
          <code className="ac-tag warn" title={modelTitle}>
            model not set
          </code>
        )}
        <code className="ac-tag">{a.permissionMode}</code>
        {a.inheritMcp &&
          (mcpAllowed.length ? (
            mcpAllowed.map((t) => (
              <code key={t} className="ac-tag" title={t}>
                {t.replace(/^mcp__(claude_ai_|plugin_)?/, "mcp ")}
              </code>
            ))
          ) : (
            <code className="ac-tag warn" title="inherit_mcp is on but no mcp__ server is in allowed_tools">
              mcp: none allowed
            </code>
          ))}
        {shownTools.map((t) => (
          <code key={t} className="ac-tag">
            {t}
          </code>
        ))}
        {hiddenTools.length > 0 && (
          <code className="ac-tag" title={hiddenTools.join("\n")}>
            +{hiddenTools.length} more
          </code>
        )}
        {denied.length > 0 && (
          <code className="ac-tag" title="disallowed_tools">
            {denied.map((t) => `-${t}`).join(" ")}
          </code>
        )}
        {a.ownBudgetUsd !== null && (
          <code className="ac-tag" title="max_budget_usd per run">
            budget {fmtBudget(a.ownBudgetUsd)}
          </code>
        )}
        {a.wrapUpReserveUsd > 0 && (
          <code
            className="ac-tag"
            title={`${fmtCost(a.wrapUpReserveUsd)} of the budget is kept for a wrap-up pass: when the main pass runs out, the session is resumed with it and told to record where it stopped (wrap_up_reserve_usd)`}
          >
            wrap-up {fmtBudget(a.wrapUpReserveUsd)}
          </code>
        )}
        {a.ownTimeoutMinutes !== null && (
          <code className="ac-tag" title="timeout_minutes per run">
            timeout {a.ownTimeoutMinutes} min
          </code>
        )}
        {!a.maxConcurrentIsDefault && (
          <code className="ac-tag" title="max_concurrent: runs of this agent allowed at once">
            ×{a.maxConcurrent} at once
          </code>
        )}
        {a.isolated && (
          <code
            className="ac-tag"
            title="isolated: promises never to edit the checkout, so the per-project guard is skipped"
          >
            isolated
          </code>
        )}
        {addDirs.length > 0 && (
          <code className="ac-tag" title={`add_dirs:\n${addDirs.map((d) => tildePath(d, home)).join("\n")}`}>
            +{addDirs.length} {addDirs.length === 1 ? "dir" : "dirs"}
          </code>
        )}
        {suggestions.map((t) => (
          <code
            key={t}
            className="ac-tag suggest"
            title={`Denied in this agent's recent runs. Add ${t} to allowed_tools to let unattended runs use it.`}
          >
            + {t}?
          </code>
        ))}
      </div>

      <div className="ac-stats">
        <Stat label="Runs" value={String(s?.total ?? 0)} />
        <Stat
          label="Clean"
          value={s ? fmtPct(s.clean, s.finished) : "–"}
          tone={cleanTone}
          title="Completed with nothing to review, over finished runs (same rule as the runs overview)"
        />
        <Stat label="Avg cost" value={fmtCost(avgCost)} />
        <Stat
          label="Last run"
          value={s?.lastRunAt ? fmtAgo(s.lastRunAt) : "never"}
          title={s?.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : undefined}
        />
      </div>

      <footer className="ac-foot">
        <Link href={runsHref}>runs →</Link>
        {scheduleIds.length > 0 && (
          <Link
            href={`/schedules#${scheduleIds[0]}`}
            title={
              scheduleIds.length > 1 ? `${scheduleIds.length} schedules: ${scheduleIds.join(", ")}` : scheduleIds[0]
            }
          >
            schedule →
          </Link>
        )}
        <AgentActions
          id={a.id}
          source={a.source}
          linked={a.claudeAgent ?? null}
          overridesBuiltin={a.overridesBuiltin}
        />
        <code className="ac-file" title={a.sourcePath}>
          {a.fileLabel}
        </code>
      </footer>
    </article>
  );
}

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string | undefined;
}) {
  return (
    <div className="ac-stat" title={title}>
      <div className="l">{label}</div>
      <div className={`v ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

/** "$1", "$0.50". */
function fmtBudget(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}
