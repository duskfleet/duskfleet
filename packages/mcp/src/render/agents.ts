/**
 * `duskfleet agents` and `agents create` for a human (DS-33): one row per agent, the description
 * filling the rest of the line, and the `✓` acknowledgement of the agent just written. The values
 * are what `--json` prints (the agents without their system prompt).
 */
import type { AgentDefinition, AgentSource } from "@duskfleet/core";
import {
  type Cell,
  type Column,
  emptyState,
  fmtCents,
  jsonLine,
  oneLine,
  type RenderOpts,
  shortModel,
  table,
} from "./primitives.js";
import { GLYPH, paint } from "./theme.js";

/** An agent as the CLI prints it: the definition without its system prompt. */
export type AgentView = Omit<AgentDefinition, "systemPrompt">;

/** `own` (persona written here) or `link` (runs a project's `.claude/agents/<name>.md`). */
export const agentKind = (a: Pick<AgentView, "claudeAgent">): "own" | "link" => (a.claudeAgent ? "link" : "own");

/** The command that writes a first agent. */
export const AGENT_CREATE = 'duskfleet agents create <id> --model haiku -- "<system prompt>"';

const COLUMNS: readonly Column[] = [
  { header: "ID", width: 20, flex: true },
  { header: "KIND", width: 4, priority: 5 },
  { header: "SOURCE", width: 7, priority: 2 },
  { header: "MODEL", width: 6, priority: 4 },
  { header: "PROJECT", width: 10, priority: 3 },
  { header: "BUDGET", width: 6, align: "right", priority: 1 },
  { header: "TIMEOUT", width: 7, align: "right", priority: 0 },
  { header: "DESCRIPTION", width: 24, fill: true },
];

const timeoutText = (minutes: number | undefined): string => (minutes === undefined ? "-" : `${minutes}m`);

/** A link with no model of its own runs the project agent's: `agent`; an own one the CLI default. */
function modelText(a: AgentView): string {
  if (a.model) return shortModel(a.model);
  return agentKind(a) === "link" ? "agent" : "default";
}

/** The table, or the empty state naming the command that writes a first agent. */
export function renderAgents(agents: readonly AgentView[], opts: RenderOpts): string[] {
  if (agents.length === 0) return emptyState("no agents yet", AGENT_CREATE, opts);
  const rows = agents.map((a): Cell[] => [
    { text: a.id, role: "accent" },
    agentKind(a),
    a.source,
    modelText(a),
    a.project ?? "none",
    a.maxBudgetUsd === undefined ? "-" : fmtCents(a.maxBudgetUsd),
    timeoutText(a.timeoutMinutes),
    oneLine(a.description ?? "") || "-",
  ]);
  return [...table(COLUMNS, rows, opts), "", jsonLine(opts, `new agent: ${AGENT_CREATE}`)];
}

export interface AgentCreated {
  created: boolean;
  /** Source of the agent the new file replaced (`--force`), null when the id was free. */
  overrode: AgentSource | null;
  agent: AgentView;
}

/** `agents create`: a `✓` line, the command that runs it, and the file written (with what it replaced). */
export function renderAgentCreated(value: AgentCreated, opts: RenderOpts): string[] {
  const a = value.agent;
  const replaced =
    value.overrode === "builtin"
      ? ` (overrides the builtin "${a.id}": delete this file to restore it)`
      : value.overrode === "user"
        ? ` (replaced the user agent "${a.id}")`
        : "";
  return [
    `${paint("ok", GLYPH.ok, opts)} agent ${paint("accent", a.id, opts)} created`,
    `  ${paint("accent", `duskfleet run --project <id or path> --agent ${a.id} -- "<task>"`, opts)}`,
    `  wrote ${a.sourcePath}${replaced}`,
  ];
}
