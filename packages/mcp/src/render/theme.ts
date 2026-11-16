/**
 * The only file of the CLI renderers with visual decisions (DS-33, the terminal design): which SGR
 * codes each role gets, and how a status reads (glyph + word). Renderers name a role and go through
 * `paint()`; they never call `styleText` themselves.
 *
 * The mapping passes on a dark and a light ground without knowing which one is in use: red 31 and
 * bright black 90 are never used (under 4.5:1 on a dark ground), dim is decoration only (hints,
 * rules, `└`, event times), and cyan / green / yellow colour a glyph, never the word next to it.
 */
import { styleText } from "node:util";
import type { RunStatus } from "@duskfleet/core";

export const ROLES = ["ok", "warn", "bad", "run", "accent", "muted", "heading", "strong"] as const;
export type Role = (typeof ROLES)[number];

type StyleFormat = Parameters<typeof styleText>[0];

export const ROLE_FORMAT: Readonly<Record<Role, StyleFormat>> = {
  /** --ok: completed, on, yes. Glyphs only. */
  ok: "green",
  /** --amber: needs review, warning, paused. Glyphs only; the word is `strong`. */
  warn: "yellow",
  /** --coral: failed, error, stopped. Glyph and word. */
  bad: ["redBright", "bold"],
  /** --sky: pending or running. Glyphs only. */
  run: "cyan",
  /** --sunset: ids and commands to copy. Never a path. */
  accent: "magenta",
  /** --muted: hints, rules, units, `└`. Never a value or a status (dim fails 4.5:1 on both grounds). */
  muted: "dim",
  /** Section headings, column headers, labels. */
  heading: "bold",
  /** A word that must stand out in the default colour: `needs review`, denied tools. */
  strong: "bold",
};

/** One piece of a line in one role; null = the terminal's default foreground. */
export interface Segment {
  text: string;
  role: Role | null;
}

/** `text` in the style of `role` when `opts.color`, else as is. */
export function paint(role: Role | null | undefined, text: string, opts: { color: boolean }): string {
  if (!opts.color || !role || text === "") return text;
  // The colour decision is already taken (opts.color): no second check of the stream here.
  return styleText(ROLE_FORMAT[role], text, { validateStream: false });
}

/** The state roles a glyph can take. */
export type StateRole = "ok" | "warn" | "bad" | "run";

export const STATUS_ROLE: Readonly<Record<RunStatus, StateRole | null>> = {
  pending: "run",
  running: "run",
  completed: "ok",
  failed: "bad",
  cancelled: null,
  timed_out: "bad",
};

export const STATUS_GLYPH: Readonly<Record<RunStatus, string>> = {
  pending: "●",
  running: "●",
  completed: "✓",
  failed: "✗",
  cancelled: "–",
  timed_out: "✗",
};

/** Glyphs of the states that are not run statuses. */
export const GLYPH = { review: "!", warn: "!", paused: "‖", ok: "✓", bad: "✗", run: "●", none: "–" } as const;

/**
 * A glyph and its word in one state: `bad` paints both (91 bold), `warn` paints the glyph and makes
 * the word bold, the others colour the glyph only and leave the word in the default colour.
 */
export function stateSegments(glyph: string, word: string, role: StateRole | null): Segment[] {
  if (role === "bad") return [{ text: word ? `${glyph} ${word}` : glyph, role: "bad" }];
  const head: Segment = { text: glyph, role };
  if (!word) return [head];
  return role === "warn"
    ? [head, { text: " ", role: null }, { text: word, role: "strong" }]
    : [head, { text: ` ${word}`, role: null }];
}

/** A run's status as glyph + word; a completed run with review reasons reads `! needs review`. */
export function runStatusSegments(status: RunStatus, needsReview = false): Segment[] {
  if (status === "completed" && needsReview) return stateSegments(GLYPH.review, "needs review", "warn");
  return stateSegments(STATUS_GLYPH[status], status.replace("_", " "), STATUS_ROLE[status]);
}
