/**
 * `duskfleet agents` and `agents create` for a human: one table row per agent, and the kv block of
 * the agent just written. The values are exactly what `--json` prints (the agents without their
 * system prompt).
 */
import type { AgentDefinition, AgentSource } from "@duskfleet/core";
import { type Cell, type Column, fmtUsd, kv, type RenderOpts, table } from "./primitives.js";
import { paint } from "./theme.js";

/** An agent as the CLI prints it: the definition without its system prompt. */
export type AgentView = Omit<AgentDefinition, "systemPrompt">;

/** `own` (persona written here) or `link` (runs a project's `.claude/agents/<name>.md`). */
export const agentKind = (a: Pick<AgentView, "claudeAgent">): "own" | "link" => (a.claudeAgent ? "link" : "own");

const COLUMNS: readonly Column[] = [
  { header: "id" },
  { header: "kind", priority: 6 },
  { header: "source", priority: 2 },
  { header: "model", priority: 5 },
  { header: "project", priority: 4 },
  { header: "budget", align: "right", priority: 3 },
  { header: "timeout", align: "right", priority: 1 },
  { header: "description", flex: true },
];

const none: Cell = { text: "-", role: "faint" };
const timeoutText = (minutes: number | undefined): string | null => (minutes === undefined ? null : `${minutes}m`);

/** The table; empty when there is no agent (the CLI prints its hint on stderr). */
export function renderAgents(agents: readonly AgentView[], opts: RenderOpts): string[] {
  if (agents.length === 0) return [];
  const rows = agents.map((a): Cell[] => [
    { text: a.id, role: "accent" },
    agentKind(a),
    { text: a.source, role: "muted" },
    a.model ?? { text: "default", role: "faint" },
    a.project ?? none,
    a.maxBudgetUsd === undefined ? none : fmtUsd(a.maxBudgetUsd),
    timeoutText(a.timeoutMinutes) ?? none,
    a.description || none,
  ]);
  return table(COLUMNS, rows, opts);
}

export interface AgentCreated {
  created: boolean;
  /** Source of the agent the new file replaced (`--force`), null when the id was free. */
  overrode: AgentSource | null;
  agent: AgentView;
}

/** `agents create`: what was written, and a line when it replaced an agent with the same id. */
export function renderAgentCreated(value: AgentCreated, opts: RenderOpts): string[] {
  const a = value.agent;
  const list = (items: readonly string[] | undefined) => (items?.length ? items.join(", ") : null);
  const lines = [`agent ${paint("accent", a.id, opts)} created`];
  if (value.overrode === "builtin") {
    lines.push(
      paint("warn", `overrides the builtin agent "${a.id}" (same id; delete the user file to restore it)`, opts),
    );
  } else if (value.overrode === "user") {
    lines.push(paint("warn", `replaced the user agent "${a.id}"`, opts));
  }
  lines.push(
    "",
    ...kv(
      [
        ["kind", agentKind(a)],
        ["model", a.model ?? { text: "default (the Claude Code default)", role: "faint" }],
        ["permission mode", a.permissionMode],
        ["allowed tools", list(a.allowedTools)],
        ["disallowed tools", list(a.disallowedTools)],
        ["budget", a.maxBudgetUsd === undefined ? null : `${fmtUsd(a.maxBudgetUsd)} per run`],
        ["timeout", timeoutText(a.timeoutMinutes)],
        ["project", a.project ?? null],
        ["description", a.description || null],
      ],
      opts,
    ),
  );
  return lines;
}
