/**
 * The only file of the CLI renderers with visual decisions: which terminal style each role gets,
 * and which role each run status takes. Renderers name a role and go through `paint()`; they
 * never call `styleText` themselves. Provisional values: the CLI design issue (#424) replaces them.
 */
import { styleText } from "node:util";
import type { RunStatus } from "@duskfleet/core";

export const ROLES = ["ok", "warn", "bad", "run", "accent", "muted", "faint", "heading"] as const;
export type Role = (typeof ROLES)[number];

type StyleFormat = Parameters<typeof styleText>[0];

export const ROLE_FORMAT: Readonly<Record<Role, StyleFormat>> = {
  /** --ok: a run that completed clean. */
  ok: "green",
  /** --warn (amber): needs review. */
  warn: "yellow",
  /** --bad (coral): failed, timed out. */
  bad: "red",
  /** --run: pending or running. */
  run: "cyan",
  /** --accent (sunset): ids and the one thing to look at. */
  accent: "magenta",
  /** --muted: keys, secondary columns. */
  muted: "dim",
  /** --faint: hints and empty values. */
  faint: "gray",
  /** --font-display weight: section titles and table headers. */
  heading: "bold",
};

export const STATUS_ROLE: Readonly<Record<RunStatus, Role>> = {
  pending: "run",
  running: "run",
  completed: "ok",
  failed: "bad",
  cancelled: "muted",
  timed_out: "bad",
};

/** `text` in the style of `role` when `opts.color`, else as is. */
export function paint(role: Role | null | undefined, text: string, opts: { color: boolean }): string {
  if (!opts.color || !role || text === "") return text;
  // The colour decision is already taken (opts.color): no second check of the stream here.
  return styleText(ROLE_FORMAT[role], text, { validateStream: false });
}
