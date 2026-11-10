/**
 * Building blocks of the CLI's human-readable output: a table that fits the terminal, an aligned
 * key block, sections, status badges and the formatting helpers. Plain strings in, lines out;
 * colour only through `paint()` (theme.ts) when `opts.color` is set, so the same renderer gives
 * the exact plain text tests pin with `color: false`.
 */
import type { RunStatus } from "@duskfleet/core";
import { paint, type Role, STATUS_ROLE } from "./theme.js";

export interface RenderOpts {
  /** Colour on (stdout is a terminal and NO_COLOR is not set, or FORCE_COLOR). */
  color: boolean;
  /** Columns available: COLUMNS, else the terminal's width, else 100. */
  width: number;
  /** "Now" for relative times; tests pin it. */
  now?: Date;
}

/** A table or key-block value: plain text, or text with the role it is painted in. */
export type Cell = string | { text: string; role: Role | null };

const cellText = (c: Cell): string => (typeof c === "string" ? c : c.text);
const cellRole = (c: Cell): Role | null => (typeof c === "string" ? null : c.role);

export interface Column {
  header: string;
  /** Numbers: right-aligned. */
  align?: "left" | "right";
  /**
   * Dropped when the table is too wide, lowest first. Absent = never dropped.
   */
  priority?: number;
  /** The one column truncated with `…` to fit (at most one per table). */
  flex?: boolean;
}

/** Narrowest a flexible column is cut to before columns get dropped. */
const FLEX_MIN = 12;
const GAP = "  ";

function cut(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? "…".slice(0, width) : `${text.slice(0, width - 1)}…`;
}

/**
 * Header plus one line per row, padded to the widest cell of each column. While the table is wider
 * than `opts.width` (with the flexible column at its minimum), the lowest-priority column is
 * dropped; then the flexible column is cut to what is left.
 */
export function table(columns: readonly Column[], rows: readonly (readonly Cell[])[], opts: RenderOpts): string[] {
  const natural = columns.map((c, i) => Math.max(c.header.length, ...rows.map((r) => cellText(r[i] ?? "").length)));
  let kept = columns.map((_, i) => i);
  const flexIndex = columns.findIndex((c) => c.flex);
  const widthOf = (idx: number[], flexWidth: number | null) =>
    idx.reduce((sum, i) => sum + (i === flexIndex && flexWidth !== null ? flexWidth : natural[i]!), 0) +
    GAP.length * (idx.length - 1);
  const flexMin =
    flexIndex === -1 ? null : Math.min(natural[flexIndex]!, Math.max(FLEX_MIN, columns[flexIndex]!.header.length));
  while (widthOf(kept, flexMin) > opts.width) {
    const droppable = kept.filter((i) => columns[i]!.priority !== undefined);
    if (droppable.length === 0) break;
    const lowest = droppable.reduce((a, b) => (columns[b]!.priority! < columns[a]!.priority! ? b : a));
    kept = kept.filter((i) => i !== lowest);
  }
  const widths = [...natural];
  if (flexIndex !== -1 && kept.includes(flexIndex)) {
    const others = widthOf(
      kept.filter((i) => i !== flexIndex),
      null,
    );
    const room = opts.width - others - (kept.length > 1 ? GAP.length : 0);
    widths[flexIndex] = Math.max(flexMin!, Math.min(natural[flexIndex]!, room));
  }
  const line = (cells: readonly Cell[], headerRow: boolean) =>
    kept
      .map((i, k) => {
        const col = columns[i]!;
        const text = cut(cellText(cells[i] ?? ""), widths[i]!);
        const last = k === kept.length - 1;
        const padded = col.align === "right" ? text.padStart(widths[i]!) : last ? text : text.padEnd(widths[i]!);
        return paint(headerRow ? "heading" : cellRole(cells[i] ?? ""), padded, opts);
      })
      .join(GAP);
  return [
    line(
      columns.map((c) => c.header),
      true,
    ),
    ...rows.map((r) => line(r, false)),
  ];
}

/** Aligned `key  value` lines; pairs whose value is null or undefined are left out. */
export function kv(pairs: readonly (readonly [string, Cell | null | undefined])[], opts: RenderOpts): string[] {
  const shown = pairs.filter((p): p is readonly [string, Cell] => p[1] !== null && p[1] !== undefined);
  const keyWidth = Math.max(0, ...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${paint("muted", k.padEnd(keyWidth), opts)}  ${paint(cellRole(v), cellText(v), opts)}`);
}

/** A titled block: the title, then its lines indented by two spaces. Empty when there are no lines. */
export function section(title: string, lines: readonly string[], opts: RenderOpts): string[] {
  if (lines.length === 0) return [];
  return [paint("heading", title, opts), ...lines.map((l) => (l === "" ? "" : `  ${l}`))];
}

/** Sections separated by one blank line, empty ones skipped. */
export function sections(blocks: readonly (readonly string[])[]): string[] {
  return blocks.filter((b) => b.length > 0).flatMap((b, i) => (i === 0 ? [...b] : ["", ...b]));
}

/** The status word (`timed_out` as `timed out`) in its role. */
export function statusCell(status: RunStatus): { text: string; role: Role } {
  return { text: status.replace("_", " "), role: STATUS_ROLE[status] };
}

export function badge(status: RunStatus, opts: RenderOpts): string {
  const c = statusCell(status);
  return paint(c.role, c.text, opts);
}

/** `850ms`, `12.3s`, `4m 05s`, `2h 03m`; `-` when unknown. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.round(s);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
  return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`, `in 4m`; the UTC date past 30 days; `-` when unknown. */
export function fmtRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const diff = now.getTime() - t;
  const abs = Math.abs(diff);
  const s = Math.floor(abs / 1000);
  if (s < 45) return "just now";
  const [n, unit] =
    s < 3600
      ? [Math.max(1, Math.round(s / 60)), "m"]
      : s < 86_400
        ? [Math.floor(s / 3600), "h"]
        : [Math.floor(s / 86_400), "d"];
  if (unit === "d" && n > 30) return new Date(t).toISOString().slice(0, 10);
  return diff >= 0 ? `${n}${unit} ago` : `in ${n}${unit}`;
}

/** `$0.0123` below ten cents, `$1.25` above; `-` when unknown. */
export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "-";
  if (usd === 0) return "$0.00";
  return Math.abs(usd) < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** A ratio as a whole percent: 0.8 -> `80%`; `-` when unknown. */
export function fmtPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "-";
  return `${Math.round(ratio * 100)}%`;
}

/** Whitespace folded to single spaces, cut at `max` characters with `...`. */
export function oneLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}
