// DS-10 Settings page: the editable keys of config/duskfleet.yaml, their copy, defaults and the
// validation the field shows before a save (the same bounds as core's config/loader.ts, which
// checks again on write). Plain data, shared by the server page and the client sections.

import type { EditableGlobalKey, GlobalValue } from "@duskfleet/core";

/** In the data dir: the mtime of config/duskfleet.yaml after the dashboard's last write. */
export const SETTINGS_MARKER = "settings-written.json";

export type FieldKind = "int" | "number" | "bool" | "sources" | "text" | "roots" | "agent";

export interface FieldDef {
  key: EditableGlobalKey;
  label: string;
  /** One line, from the comment of the key in config/duskfleet.yaml. */
  description: string;
  kind: FieldKind;
  unit?: string;
  min?: number;
  max?: number;
  /** The loader's default (docs/configuration.md). */
  default: GlobalValue;
  /** Shown as "Default …". */
  defaultLabel: string;
  /** What "Reset to default" writes, when it is not `default` (claude.setting_sources). */
  resetTo?: GlobalValue;
  /** Read once by the MCP host: "↻ Restart MCP host" instead of "→ Next run". */
  restart?: boolean;
}

export interface SectionDef {
  id: string;
  title: string;
  blurb: string;
  fields: FieldDef[];
}

export const SETTING_SOURCES = ["project", "local", "user"] as const;

export const SECTIONS: SectionDef[] = [
  {
    id: "concurrency",
    title: "Concurrency",
    blurb: "Limits are checked when a run starts; a run over a limit is refused, not queued",
    fields: [
      {
        key: "max_concurrent_runs",
        label: "Max concurrent runs",
        description: "Maximum number of Claude Code processes running at the same time. Always the hard cap.",
        kind: "int",
        unit: "runs",
        min: 1,
        default: 2,
        defaultLabel: "2",
      },
      {
        key: "max_concurrent_per_project",
        label: "Max concurrent per project",
        description:
          "Two agents in the same working copy would fight over branches and files. An agent with isolated: true does not count.",
        kind: "int",
        unit: "runs",
        min: 1,
        default: 1,
        defaultLabel: "1",
      },
      {
        key: "max_concurrent_per_agent",
        label: "Max concurrent per agent",
        description:
          "A scheduler tick must not start an agent whose previous run is still going. An agent's own max_concurrent overrides it.",
        kind: "int",
        unit: "runs",
        min: 1,
        default: 1,
        defaultLabel: "1",
      },
    ],
  },
  {
    id: "scheduler",
    title: "Scheduler",
    blurb: "Read by the lease holder on every tick",
    fields: [
      {
        key: "scheduler.tick_seconds",
        label: "Tick seconds",
        description: "How often the lease holder looks for due schedules.",
        kind: "int",
        unit: "s",
        min: 5,
        max: 300,
        default: 30,
        defaultLabel: "30",
      },
      {
        key: "scheduler.auto_pause_after",
        label: "Auto-pause after",
        description:
          "Pause a schedule after this many consecutive runs that completed with 0 tool calls or ended needs review. 0 = never.",
        kind: "int",
        unit: "runs",
        min: 0,
        default: 5,
        defaultLabel: "5",
      },
    ],
  },
  {
    id: "claude",
    title: "Claude defaults",
    blurb: "Per-run defaults; an agent can override timeout and budget",
    fields: [
      {
        key: "claude.default_timeout_minutes",
        label: "Timeout",
        description: "Default per-run time limit, overridable per agent.",
        kind: "number",
        unit: "min",
        default: 30,
        defaultLabel: "30",
      },
      {
        key: "claude.default_max_budget_usd",
        label: "Max budget",
        description: "Default per-run spend limit in USD, overridable per agent.",
        kind: "number",
        unit: "USD",
        default: 5,
        defaultLabel: "5",
      },
      {
        key: "claude.strict_mcp_config",
        label: "Strict MCP config",
        description:
          "On: runs see no MCP server (fast, cannot recurse into Duskfleet). An agent or project with inherit_mcp: true opts out.",
        kind: "bool",
        default: true,
        defaultLabel: "on",
      },
      {
        key: "claude.setting_sources",
        label: "Setting sources",
        description:
          "Which Claude Code settings files runs load. project + local skip ~/.claude/settings.json, whose hooks can hang unattended runs.",
        kind: "sources",
        default: null,
        defaultLabel: "all (null); Reset restores the shipped project, local",
        resetTo: ["project", "local"],
        restart: true,
      },
      {
        key: "claude.binary",
        label: "Binary",
        description:
          "Path to the Claude Code binary. Order: CLAUDE_BIN env var, this value, claude on PATH, ~/.local/bin/claude.",
        kind: "text",
        default: null,
        defaultLabel: "none (null)",
        restart: true,
      },
    ],
  },
  {
    id: "projects",
    title: "Projects",
    blurb: "Where agents may run and which agent runs by default",
    fields: [
      {
        key: "allowed_project_roots",
        label: "Allowed project roots",
        description:
          "Safety fence: a project path must be inside one of these directories. Empty allows any existing directory except / and your home directory.",
        kind: "roots",
        default: [],
        defaultLabel: "[] (empty)",
      },
      {
        key: "default_agent",
        label: "Default agent",
        description: "Agent used by run_agent when no agent_id is given. None makes agent_id mandatory.",
        kind: "agent",
        default: null,
        defaultLabel: "none (null)",
      },
    ],
  },
];

/** What a field holds while it is edited: numbers as typed, so "2.5" can be shown as invalid. */
export type Draft = string | boolean | string[];

export function toDraft(def: FieldDef, value: GlobalValue): Draft {
  switch (def.kind) {
    case "int":
    case "number":
      return value === null || value === undefined ? "" : String(value);
    case "bool":
      return value === true;
    case "sources":
      // null = all three; canonical order, so a draft compares equal to the file's value
      return SETTING_SOURCES.filter((s) => value === null || (Array.isArray(value) && value.includes(s)));
    case "roots":
      return Array.isArray(value) ? value : [];
    default:
      return typeof value === "string" ? value : "";
  }
}

/** The YAML value of a draft. Callers check `fieldError` first. */
export function fromDraft(def: FieldDef, draft: Draft): GlobalValue {
  switch (def.kind) {
    case "int":
    case "number":
      return Number(draft);
    case "bool":
      return draft === true;
    case "sources":
      // Canonical order, as in the shipped file: [project, local]
      return SETTING_SOURCES.filter((s) => (draft as string[]).includes(s));
    case "roots":
      return (draft as string[]).map((r) => r.trim()).filter(Boolean);
    default: {
      const s = String(draft).trim();
      return s === "" ? null : s;
    }
  }
}

/** The invalid-state message of a field, or null. Mirrors the zod schema of config/loader.ts. */
export function fieldError(def: FieldDef, draft: Draft): string | null {
  if (def.kind !== "int" && def.kind !== "number") return null;
  const text = String(draft).trim();
  const n = Number(text);
  if (def.kind === "int") {
    const range =
      def.max !== undefined ? `Whole number, ${def.min} to ${def.max}` : `Whole number, ${def.min ?? 0} or more`;
    if (text === "" || !Number.isInteger(n)) return text === "" ? range : `${range} (${text} is not)`;
    if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
      return `${range} (${text} is not)`;
    }
    return null;
  }
  if (text === "" || !Number.isFinite(n) || n <= 0)
    return text === "" ? "A number above 0" : `A number above 0 (${text} is not)`;
  return null;
}

/** "2", "on", "project, local", "none" — for "was …", the dialog and the collapsed summary. */
export function formatValue(def: FieldDef, value: GlobalValue): string {
  if (value === null || value === undefined) return def.kind === "sources" ? "all" : "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? (def.kind === "roots" ? "no roots" : "none") : value.join(", ");
  return String(value);
}
