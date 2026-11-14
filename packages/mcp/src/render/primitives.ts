/**
 * Building blocks of the CLI's human-readable output: a table of fixed column widths that fits the
 * terminal, an aligned key block, sections, `└` follow-up lines and the formatting helpers. Plain
 * strings in, lines out; colour only through `paint()` (theme.ts) when `opts.color` is set, so the
 * same renderer gives the exact plain text tests pin with `color: false`.
 */
import os from "node:os";
import type { RunStatus } from "@duskfleet/core";
import { paint, runStatusSegments, type Segment } from "./theme.js";

export type { Segment } from "./theme.js";

export interface RenderOpts {
  /** Colour on (stdout is a terminal and NO_COLOR is not set, or FORCE_COLOR). */
  color: boolean;
  /** Columns available: COLUMNS, else the terminal's width, else 100. */
  width: number;
  /** "Now" for relative times; tests pin it. */
  now?: Date;
}

/** A table or key-block value: plain text, one painted segment, or several. */
export type Cell = string | Segment | readonly Segment[];

export function segmentsOf(c: Cell): readonly Segment[] {
  if (typeof c === "string") return [{ text: c, role: null }];
  return Array.isArray(c) ? (c as readonly Segment[]) : [c as Segment];
}

export const cellText = (c: Cell): string =>
  segmentsOf(c)
    .map((s) => s.text)
    .join("");

/** The cell painted, segment by segment. */
export function paintCell(c: Cell, opts: RenderOpts): string {
  return segmentsOf(c)
    .map((s) => paint(s.role, s.text, opts))
    .join("");
}

/** The segments cut to `width` characters, the last one ending in `…` when something was cut. */
export function cutSegments(segs: readonly Segment[], width: number): Segment[] {
  const total = segs.reduce((n, s) => n + s.text.length, 0);
  if (total <= width) return [...segs];
  if (width <= 0) return [];
  const out: Segment[] = [];
  let left = width - 1;
  for (const s of segs) {
    if (left <= 0) break;
    const text = s.text.slice(0, left);
    out.push({ text, role: s.role });
    left -= text.length;
  }
  const last = out.at(-1);
  if (last) last.text += "…";
  else out.push({ text: "…", role: segs[0]?.role ?? null });
  return out;
}

/** `text` cut to `width` with `…` at the end. */
export function cut(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? "…".slice(0, width) : `${text.slice(0, width - 1)}…`;
}

/** A path cut in the middle (`/home/me/…/config.json`): the start and the file name stay. */
export function cutMiddle(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 4) return cut(text, width);
  const keep = width - 3;
  const tail = Math.ceil(keep / 2);
  return `${text.slice(0, keep - tail)}/…/${text.slice(text.length - tail)}`;
}

export interface Column {
  header: string;
  /** Design width in characters; absent = the widest cell. */
  width?: number;
  /** Numbers: right-aligned. */
  align?: "left" | "right";
  /** Dropped when the table is too wide, lowest first. Absent = never dropped. */
  priority?: number;
  /** The one column that gives way: cut to `min` before columns drop, grows into spare room. */
  flex?: boolean;
  /** Floor of the flexible column (default 12). */
  min?: number;
  /** The last column takes what is left of the line, cut with `…`. */
  fill?: boolean;
  /** `middle`: cut in the middle with `/…/` (paths); default: at the end with `…`. */
  truncate?: "end" | "middle";
}

const FLEX_MIN = 12;
const GAP = "  ";

/**
 * Header plus one line per row, each column at its design width (`width`), two spaces between
 * columns. While the table is wider than `opts.width` with the flexible column at its floor, the
 * lowest-priority column is dropped; then the flexible column takes the room left (up to its
 * widest cell), and a `fill` column takes the rest. Cells wider than their column end in `…`.
 */
export function table(columns: readonly Column[], rows: readonly (readonly Cell[])[], opts: RenderOpts): string[] {
  const natural = columns.map((c, i) => Math.max(c.header.length, ...rows.map((r) => cellText(r[i] ?? "").length)));
  const base = columns.map((c, i) => c.width ?? natural[i]!);
  const flexIndex = columns.findIndex((c) => c.flex);
  const fillIndex = columns.findIndex((c) => c.fill);
  const floor = (i: number) =>
    i === flexIndex
      ? Math.min(base[i]!, columns[i]!.min ?? FLEX_MIN)
      : i === fillIndex
        ? Math.min(base[i]!, columns[i]!.header.length)
        : base[i]!;
  const sum = (idx: readonly number[], w: (i: number) => number) =>
    idx.reduce((n, i) => n + w(i), 0) + GAP.length * Math.max(0, idx.length - 1);

  let kept = columns.map((_, i) => i);
  while (sum(kept, floor) > opts.width) {
    const droppable = kept.filter((i) => columns[i]!.priority !== undefined);
    if (droppable.length === 0) break;
    const lowest = droppable.reduce((a, b) => (columns[b]!.priority! < columns[a]!.priority! ? b : a));
    kept = kept.filter((i) => i !== lowest);
  }

  const widths = [...base];
  const elastic = [flexIndex, fillIndex].filter((i) => i !== -1 && kept.includes(i));
  if (elastic.length > 0) {
    // Room for the elastic columns together: the line minus every gap and the fixed columns.
    let room =
      opts.width -
      GAP.length * (kept.length - 1) -
      kept.filter((i) => !elastic.includes(i)).reduce((n, i) => n + base[i]!, 0);
    const fillKept = fillIndex !== -1 && kept.includes(fillIndex);
    if (flexIndex !== -1 && kept.includes(flexIndex)) {
      // With a fill column the spare room is the fill's: the flexible one stays at its design width.
      const preferred = fillKept ? base[flexIndex]! : Math.max(base[flexIndex]!, natural[flexIndex]!);
      widths[flexIndex] = Math.max(floor(flexIndex), Math.min(preferred, room - (fillKept ? floor(fillIndex) : 0)));
      room -= widths[flexIndex]!;
    }
    if (fillKept) {
      widths[fillIndex] = Math.max(floor(fillIndex), Math.min(natural[fillIndex]!, room));
    }
  }

  const line = (cells: readonly Cell[], headerRow: boolean) => {
    const parts = kept.map((i, k) => {
      const col = columns[i]!;
      const w = widths[i]!;
      const cell = cells[i] ?? "";
      const segs =
        col.truncate === "middle" && cellText(cell).length > w
          ? [{ text: cutMiddle(cellText(cell), w), role: null }]
          : cutSegments(headerRow ? [{ text: cellText(cell), role: "heading" }] : segmentsOf(cell), w);
      const len = segs.reduce((n, s) => n + s.text.length, 0);
      const text = segs.map((s) => paint(s.role, s.text, opts)).join("");
      const pad = " ".repeat(Math.max(0, w - len));
      if (col.align === "right") return pad + text;
      return k === kept.length - 1 ? text : text + pad;
    });
    return parts.join(GAP).trimEnd();
  };
  return [
    line(
      columns.map((c) => c.header),
      true,
    ),
    ...rows.map((r) => line(r, false)),
  ];
}

/** Start column of column `index` (`kept` is not known outside: use it for columns that never drop). */
export function columnOffset(columns: readonly Column[], index: number): number {
  return columns.slice(0, index).reduce((n, c) => n + (c.width ?? 0) + GAP.length, 0);
}

/**
 * Aligned `key  value` lines, keys bold (labels), padded to `keyWidth` (default: the longest key);
 * pairs whose value is null or undefined are left out.
 */
export function kv(
  pairs: readonly (readonly [string, Cell | null | undefined])[],
  opts: RenderOpts,
  keyWidth?: number,
): string[] {
  const shown = pairs.filter((p): p is readonly [string, Cell] => p[1] !== null && p[1] !== undefined);
  const width = keyWidth ?? Math.max(0, ...shown.map(([k]) => k.length + 2));
  return shown.map(
    ([k, v]) => `${paint("heading", k, opts)}${" ".repeat(Math.max(2, width - k.length))}${paintCell(v, opts)}`,
  );
}

/** Widest line a section rule reaches, whatever the terminal. */
const RULE_MAX = 100;

/** A bold title followed by a dim `──` rule to the width (capped at 100). */
export function heading(title: string, opts: RenderOpts): string {
  const room = Math.min(opts.width, RULE_MAX) - title.length - 1;
  return `${paint("heading", title, opts)} ${paint("muted", "─".repeat(Math.max(2, room)), opts)}`;
}

/** A titled block: the heading, then its lines indented by two spaces. Empty when there are no lines. */
export function section(title: string, lines: readonly string[], opts: RenderOpts): string[] {
  if (lines.length === 0) return [];
  return [heading(title, opts), ...lines.map((l) => (l === "" ? "" : `  ${l}`))];
}

/** Sections separated by one blank line, empty ones skipped. */
export function sections(blocks: readonly (readonly string[])[]): string[] {
  return blocks.filter((b) => b.length > 0).flatMap((b, i) => (i === 0 ? [...b] : ["", ...b]));
}

/** An indented `└ text` line under a row, cut at the right edge with `…`. */
export function followUp(text: Cell, indent: number, opts: RenderOpts): string {
  const segs: Segment[] = [
    { text: " ".repeat(indent), role: null },
    { text: "└", role: "muted" },
    { text: " ", role: null },
  ];
  return cutSegments([...segs, ...segmentsOf(text)], opts.width)
    .map((s) => paint(s.role, s.text, opts))
    .join("");
}

/** The last line of a screen, dim: `json: add --json`, plus a pointer when there is one. */
export function jsonLine(opts: RenderOpts, pointer?: string): string {
  return paint("muted", `json: add --json${pointer ? ` · ${pointer}` : ""}`, opts);
}

/** An empty state: a bold one-liner, then the command that fixes it in the accent colour. */
export function emptyState(text: string, command: string, opts: RenderOpts): string[] {
  return [paint("heading", text, opts), `  ${paint("accent", command, opts)}`];
}

/** A run status as glyph + word (`✓ completed`, `! needs review`, `✗ failed`). */
export function statusCell(status: RunStatus, needsReview = false): Segment[] {
  return runStatusSegments(status, needsReview);
}

export function badge(status: RunStatus, opts: RenderOpts, needsReview = false): string {
  return paintCell(statusCell(status, needsReview), opts);
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
  if (Math.abs(diff) < 45_000) return "just now";
  const age = fmtAge(iso, now);
  if (Math.abs(diff) > 30 * 86_400_000) return new Date(t).toISOString().slice(0, 10);
  return diff >= 0 ? `${age} ago` : `in ${age}`;
}

/** A list's age, past or future: `now`, `2m`, `18m`, `3h`, `2d`; `-` when unknown. */
export function fmtAge(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const s = Math.floor(Math.abs(now.getTime() - t) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** An absolute UTC time and its age: `2026-11-09 11:55:00 UTC (5m ago)`; null when unknown. */
export function fmtWhen(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return `${t.toISOString().slice(0, 19).replace("T", " ")} UTC (${fmtRelative(iso, now)})`;
}

/** `$0.0123` below ten cents, `$1.25` above; `-` when unknown. */
export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "-";
  if (usd === 0) return "$0.00";
  return Math.abs(usd) < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * Cents, for amounts a human set (a budget's amount, an agent's `max_budget_usd`, caps): `$0.08`,
 * `$12.40`, `$0.00` when zero was configured; `-` when unknown. Measured costs use `fmtCost`.
 */
export function fmtCents(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "-";
  return `$${usd.toFixed(2)}`;
}

/**
 * A measured cost, one run's or a sum of runs' (the `runs` total, a budget's counted spend and
 * stand-ins): `$0.08` from a cent up, `<$0.01` for a non-zero cost under a cent (decided on the
 * value: 0.0099 rounds to `0.01` but is still under a cent), `$0.00` for exactly 0, `-` when
 * unknown. Amounts a human set keep `fmtCents`.
 */
export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "-";
  // A sum of floats can land a hair under a cent (0.003 + 0.007): compare at a micro-dollar.
  const value = Math.round(usd * 1e6) / 1e6;
  if (value > 0 && value < 0.01) return "<$0.01";
  return fmtCents(value);
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

/** The home directory shown as `~`. */
export function tildePath(p: string, home: string = os.homedir()): string {
  if (!home || home === "/") return p;
  if (p === home) return "~";
  return p.startsWith(`${home}/`) || p.startsWith(`${home}\\`) ? `~${p.slice(home.length)}` : p;
}

/** A model id as its family (`claude-haiku-4-5` -> `haiku`); other names as they are. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "-";
  return /\b(opus|sonnet|haiku)\b/i.exec(model.replace(/[-_.]/g, " "))?.[1]?.toLowerCase() ?? model;
}
