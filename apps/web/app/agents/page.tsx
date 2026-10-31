import path from "node:path";
import Link from "next/link";
import { AgentStatus } from "@/components/AgentStatus";
import { MultiSelect, type MultiSelectOption } from "@/components/MultiSelect";
import { Spark } from "@/components/Spark";
import { type AgentState, agentState, cleanTone } from "@/lib/agents";
import {
  type AgentStats,
  type AgentWindow,
  agentStats,
  agentWindows,
  listAgents,
  listProjects,
  listSchedules,
  projectAgentsFor,
} from "@/lib/data";
import { fmtAgo, fmtCost, fmtPct, fmtTime, shortModel } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Agents · Duskfleet" };

type Agent = ReturnType<typeof listAgents>[number];
type Search = { project?: string | string[]; status?: string | string[]; q?: string | string[]; sort?: string };

/** The Project filter's value for agents bound to no registered project. */
const ANY = "_any";
const STATES: Array<{ value: AgentState; label: string }> = [
  { value: "idle", label: "idle" },
  { value: "running", label: "running" },
  { value: "review", label: "needs review" },
  { value: "paused", label: "paused · auto" },
];
const SORTS = { last: "last run", id: "id", runs: "runs", clean: "clean", cost: "cost" } as const;
type Sort = keyof typeof SORTS;

const many = (v: string | string[] | undefined): string[] =>
  [...new Set((Array.isArray(v) ? v : [v]).filter(Boolean))] as string[];
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

interface Row {
  agent: Agent;
  stats: AgentStats | undefined;
  week: AgentWindow | undefined;
  state: AgentState;
  scheduleIds: string[];
  description: string;
}

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const agents = listAgents();
  const projects = listProjects();
  const stats = new Map(agentStats().map((s) => [s.agentId, s]));
  const weeks = agentWindows(7);
  const schedulesByAgent = new Map<string, string[]>();
  const autoPaused = new Set<string>();
  for (const s of listSchedules()) {
    schedulesByAgent.set(s.agentId, [...(schedulesByAgent.get(s.agentId) ?? []), s.id]);
    if (!s.enabled && s.pausedReason && s.autoPausedAt) autoPaused.add(s.agentId);
  }

  const groupOf = (a: Agent) => (a.project && projects.some((p) => p.id === a.project) ? a.project : ANY);
  const rows: Row[] = agents.map((a) => {
    const s = stats.get(a.id);
    return {
      agent: a,
      stats: s,
      week: weeks.get(a.id),
      state: agentState({
        running: (s?.running ?? 0) > 0,
        autoPaused: autoPaused.has(a.id),
        lastNeedsReview: s?.lastNeedsReview ?? false,
      }),
      scheduleIds: schedulesByAgent.get(a.id) ?? [],
      description:
        a.description ||
        a.linked?.description ||
        (a.claudeAgent ? `Runs claude --agent ${a.claudeAgent} in the project.` : "No description."),
    };
  });

  // Filters: unknown values are ignored rather than hiding every row.
  const projectIds = many(sp.project).filter((id) => id === ANY || projects.some((p) => p.id === id));
  const statuses = many(sp.status).filter((v) => STATES.some((s) => s.value === v));
  const q = one(sp.q)?.trim() || undefined;
  const sortParam = one(sp.sort);
  const sort: Sort = sortParam && Object.hasOwn(SORTS, sortParam) ? (sortParam as Sort) : "last";
  const filtered = Boolean(projectIds.length || statuses.length || q);

  type Next = { project?: string[]; status?: string[]; q?: string | undefined; sort?: Sort };
  const qs = (next: Next) => {
    const p = new URLSearchParams();
    const merged = { project: projectIds, status: statuses, q, sort: sort === "last" ? undefined : sort, ...next };
    for (const k of ["project", "status", "q", "sort"] as const) {
      const v = merged[k];
      for (const x of Array.isArray(v) ? v : [v]) if (x && !(k === "sort" && x === "last")) p.append(k, x);
    }
    const s = p.toString();
    return s ? `/agents?${s}` : "/agents";
  };
  const toggled = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const needle = q?.toLowerCase();
  const shown = rows.filter(
    (r) =>
      (!projectIds.length || projectIds.includes(groupOf(r.agent))) &&
      (!statuses.length || statuses.includes(r.state)) &&
      (!needle ||
        r.agent.id.toLowerCase().includes(needle) ||
        r.agent.name.toLowerCase().includes(needle) ||
        r.description.toLowerCase().includes(needle)),
  );
  const cleanPct = (r: Row) => (r.week && r.week.finished > 0 ? r.week.clean / r.week.finished : -1);
  const by: Record<Sort, (a: Row, b: Row) => number> = {
    last: (a, b) => (b.stats?.lastRunAt ?? "").localeCompare(a.stats?.lastRunAt ?? ""),
    id: (a, b) => a.agent.id.localeCompare(b.agent.id),
    runs: (a, b) => (b.week?.runs ?? 0) - (a.week?.runs ?? 0),
    clean: (a, b) => cleanPct(b) - cleanPct(a),
    cost: (a, b) => (b.week?.costUsd ?? 0) - (a.week?.costUsd ?? 0),
  };
  shown.sort((a, b) => by[sort](a, b) || a.agent.id.localeCompare(b.agent.id));

  // One group per project, the general-purpose one first; empty groups are left out.
  const groups = [
    { key: ANY, label: "Any project", id: null as string | null },
    ...projects.map((p) => ({ key: p.id, label: "Project", id: p.id as string | null })),
  ]
    .map((g) => ({ ...g, rows: shown.filter((r) => groupOf(r.agent) === g.key) }))
    .filter((g) => g.rows.length > 0);

  const projectOptions: MultiSelectOption[] = [
    { value: ANY, label: "any project", title: "Agents bound to no registered project" },
    ...projects.map((p) => ({ value: p.id, label: p.id, title: p.path })),
  ].map((o) => ({ ...o, href: qs({ project: toggled(projectIds, o.value) }) }));
  const statusOptions: MultiSelectOption[] = STATES.map((s) => ({
    value: s.value,
    label: s.label,
    href: qs({ status: toggled(statuses, s.value) }),
  }));

  // KPIs: every configured agent, whatever the filters show.
  const running = rows.filter((r) => r.state === "running");
  const groupCount = new Set(agents.map(groupOf)).size;
  const linkCount = agents.filter((a) => a.claudeAgent).length;

  // Agents a project defines in .claude/agents that no Duskfleet agent links to yet.
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
          Agents are files: edit them, or ask <code>create_agent</code> over MCP.
        </span>
      </div>

      <section className="stats agents-kpis" aria-label="Agents">
        <div className="stat">
          <div className="label">Agents</div>
          <div className="value">{agents.length}</div>
          <div className="sub">
            {agents.length - linkCount} own · {linkCount} link · {groupCount} {groupCount === 1 ? "group" : "groups"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Running now</div>
          <div className={`value ${running.length ? "run" : ""}`}>{running.length}</div>
          <div className="sub" title={running.map((r) => r.agent.id).join(", ") || undefined}>
            {running.length ? running.map((r) => r.agent.id).join(", ") : "idle"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Needs review</div>
          <div className={`value ${rows.some((r) => r.state === "review") ? "warn" : ""}`}>
            {rows.filter((r) => r.stats?.lastNeedsReview).length}
          </div>
          <div className="sub">last run ended with a review reason</div>
        </div>
        <div className="stat">
          <div className="label">Paused</div>
          <div className="value">{autoPaused.size}</div>
          <div className="sub">a bound schedule was auto-paused</div>
        </div>
      </section>

      <div className="toolbar agents-toolbar">
        <div className="toolbar-row runs-filters">
          <MultiSelect
            path="/agents"
            param="project"
            label="Project"
            noun="projects"
            options={projectOptions}
            selected={projectIds}
            clearHref={qs({ project: [] })}
            selectAllHref={qs({ project: projectOptions.map((o) => o.value) })}
          />
          <MultiSelect
            path="/agents"
            param="status"
            label="Status"
            noun="statuses"
            options={statusOptions}
            selected={statuses}
            clearHref={qs({ status: [] })}
            selectAllHref={qs({ status: STATES.map((s) => s.value) })}
          />
          {/* key: a new sort remounts the menu, so it closes after a pick */}
          <details className="ms sort-menu" key={sort}>
            <summary>
              <span className="ms-label">sorted by</span>
              <span className="ms-values">
                {SORTS[sort]} {sort === "id" ? "↑" : "↓"}
              </span>
            </summary>
            <div className="ms-pop">
              {(Object.keys(SORTS) as Sort[]).map((k) => (
                <Link
                  key={k}
                  href={qs({ sort: k })}
                  className={`ms-option ${k === sort ? "checked" : ""}`}
                  aria-current={k === sort ? "true" : undefined}
                >
                  {SORTS[k]} {k === "id" ? "↑" : "↓"}
                </Link>
              ))}
            </div>
          </details>
          {/* biome-ignore lint/a11y/useSemanticElements: the <search> element is not styled here; role="search" on the form is the established pattern */}
          <form className="search" action="/agents" method="get" role="search">
            {projectIds.map((id) => (
              <input key={`p-${id}`} type="hidden" name="project" value={id} />
            ))}
            {statuses.map((s) => (
              <input key={`s-${s}`} type="hidden" name="status" value={s} />
            ))}
            {sort !== "last" && <input type="hidden" name="sort" value={sort} />}
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search agents by id or description"
              aria-label="Search agents"
            />
            <button type="submit" className="search-btn">
              Search
            </button>
            {q && (
              <Link href={qs({ q: undefined })} className="clear">
                × clear search
              </Link>
            )}
          </form>
        </div>
      </div>

      {groups.length === 0 && (
        <div className="empty">
          {filtered ? (
            <>
              No agents match these filters. <Link href="/agents">Clear filters</Link>
            </>
          ) : (
            <>
              No agents yet. Create one with <code>agents create</code> or <code>create_agent</code>.
            </>
          )}
        </div>
      )}

      {groups.map((g) => (
        <section key={g.key} className="agent-section">
          <h2>
            {g.label}
            {g.id && <code className="h2-id">{g.id}</code>}
            <span className="count">{g.rows.length}</span>
          </h2>
          <table className="agent-table">
            <thead>
              <tr>
                <th className="c-status">Status</th>
                <th className="c-agent">Agent</th>
                <th className="c-model">Model</th>
                <th className="c-runs">Runs 7d</th>
                <th className="c-clean">Clean</th>
                <th className="c-cost">Cost 7d</th>
                <th className="c-last">Last run</th>
                <th className="c-links">
                  <span className="sr-only">Links</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <AgentRow key={r.agent.id} row={r} />
              ))}
            </tbody>
          </table>
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

/**
 * DS-21 `Agent/Row`: one markup for both widths. Wide, a table row of 8 cells; under 720 px the
 * CSS lays the same cells out as a 4-line block, each number with its column label above it.
 */
function AgentRow({ row: r }: { row: Row }) {
  const a = r.agent;
  const w = r.week;
  const runsHref = `/?agent=${encodeURIComponent(a.id)}${a.project ? `&project=${encodeURIComponent(a.project)}` : ""}`;
  const tone = w ? cleanTone(w.clean, w.finished) : "";
  const lastRunAt = r.stats?.lastRunAt ?? null;
  const ago = lastRunAt ? fmtAgo(lastRunAt) : null;
  return (
    <tr className="ar" id={a.id}>
      <td className="ar-status">
        <AgentStatus state={r.state} />
      </td>
      <td className="ar-agent">
        <div className="ar-name">
          <Link href={`/agents/${encodeURIComponent(a.id)}`} className="ar-id" title={a.name !== a.id ? a.name : a.id}>
            {a.id}
          </Link>
          <span className={`ac-kind ${a.claudeAgent ? "link" : ""}`}>{a.claudeAgent ? "link" : "own"}</span>
        </div>
        <div className="ar-desc" title={r.description}>
          {r.description}
        </div>
      </td>
      <td className="ar-model">
        {a.effectiveModel ? (
          <code title={a.effectiveModel}>{shortModel(a.effectiveModel)}</code>
        ) : (
          <code
            className="warn-text"
            title="No model set: runs use the Claude Code default, which can be the most expensive model"
          >
            default
          </code>
        )}
      </td>
      <td className="ar-runs">
        <span className="ar-l">Runs 7d</span>
        <span className="ar-v">
          {w?.runs ?? 0}
          <Spark values={w?.runsByDay ?? new Array(7).fill(0)} today={r.state === "running" ? "live" : ""} />
        </span>
      </td>
      <td className="ar-clean">
        <span className="ar-l">Clean</span>
        <span className={`ar-v ${tone}`} title="Completed with nothing to review, over finished runs (7 days)">
          {w ? fmtPct(w.clean, w.finished) : "–"}
        </span>
      </td>
      <td className="ar-cost">
        <span className="ar-l">Cost 7d</span>
        <span className="ar-v">{fmtCost(w?.costUsd ?? 0)}</span>
      </td>
      <td className="ar-last">
        <span className="ar-l">Last run</span>
        <span className="ar-v" title={lastRunAt ? fmtTime(lastRunAt) : undefined}>
          {ago === null ? "never" : /^\d+ (min|h|d)$/.test(ago) ? `${ago} ago` : ago}
        </span>
      </td>
      <td className="ar-links">
        <Link href={runsHref}>runs →</Link>
        {r.scheduleIds.length > 0 && (
          <Link
            href={`/schedules#${r.scheduleIds[0]}`}
            title={
              r.scheduleIds.length > 1 ? `${r.scheduleIds.length} schedules: ${r.scheduleIds.join(", ")}` : undefined
            }
          >
            schedule →
          </Link>
        )}
      </td>
    </tr>
  );
}
