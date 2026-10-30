import type { CostBasis, CostSplit } from "@duskfleet/core";

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Offset inside a run as a clock, e.g. "00:00.4", "00:12.8", "05:52", "1:02:10". */
export function fmtOffset(ms: number): string {
  const clamped = Math.max(0, ms);
  // Tenths in the first minute, where most events land within the same second.
  if (clamped < 60_000) return `00:${(Math.floor(clamped / 100) / 10).toFixed(1).padStart(4, "0")}`;
  const total = Math.floor(clamped / 1000);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "–";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** A cost sum in the wording of its basis (costLabels): mixed keeps billed and API value apart. */
export function fmtSplit(split: CostSplit, basis: CostBasis): string {
  if (basis === "mixed") return `${fmtCost(split.apiUsd)} billed · ${fmtCost(split.subscriptionUsd)} API value`;
  return fmtCost(basis === "api" ? split.apiUsd : split.subscriptionUsd);
}

/** Tooltip for a run's cost by billing type; null when it says nothing (api is billed, unknown is unknown). */
export function billingNote(billingType: "api" | "subscription" | null | undefined): string | null {
  return billingType === "subscription"
    ? "Subscription run: usage at API value, included in your Claude subscription, not billed"
    : billingType === "api"
      ? "API key run: billed per token"
      : null;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString();
}

/** Page header clock, e.g. "Sunday 12 Oct · 21:08". */
export function fmtDayClock(d: Date): string {
  const day = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }).replace(",", "");
  const clock = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${clock}`;
}

/** "just now", "3 min ago", "2 h ago", "today 14:32", "yesterday 09:10", "4 days ago", else a short date. */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const t = new Date(iso);
  const diff = Math.max(0, now - t.getTime());
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  const clock = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const sameDay =
    t.getFullYear() === today.getFullYear() && t.getMonth() === today.getMonth() && t.getDate() === today.getDate();
  if (sameDay) return h < 6 ? `${h} h ago` : `today ${clock}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (
    t.getFullYear() === yesterday.getFullYear() &&
    t.getMonth() === yesterday.getMonth() &&
    t.getDate() === yesterday.getDate()
  )
    return `yesterday ${clock}`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} days ago`;
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function clock(t: Date): string {
  return t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Wall-clock moment: "02:06" today, "yesterday 18:40", "Fri 09:15" this week, else "12 Oct". */
export function fmtClock(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const t = new Date(iso);
  const today = new Date(now);
  // Local midnight N days back (not N * 24 h: DST days are 23 or 25 h long).
  const since = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days).getTime();
  if (t.getTime() >= since(0)) return clock(t);
  if (t.getTime() >= since(1)) return `yesterday ${clock(t)}`;
  if (t.getTime() >= since(6)) return `${t.toLocaleDateString(undefined, { weekday: "short" })} ${clock(t)}`;
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Compact age for stat cells: "now", "2 min", "19 h", "3 d", else a short date. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const t = new Date(iso);
  const min = Math.floor(Math.max(0, now - t.getTime()) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d`;
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : n.toLocaleString();
}

export function fmtPct(num: number, den: number): string {
  if (den === 0) return "–";
  return `${Math.round((num / den) * 100)}%`;
}

export function elapsedSince(iso: string | null): number | null {
  return iso ? Date.now() - new Date(iso).getTime() : null;
}

/** "claude-haiku-5-5" → "haiku 5.5"; "claude-haiku-4-5-20251001" → "haiku 4.5"; "claude-sonnet-4-20250514" → "sonnet 4"; aliases pass through. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "default";
  // A minor version is one or two digits; an 8-digit date suffix is not one.
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model);
  if (m) return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`;
  return model;
}

/** Last two path segments, for compact display. */
export function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

/**
 * Short identity of a run: the first non-empty line of the prompt, markdown
 * markers stripped, cut at a word boundary around `max` characters. The full
 * prompt stays available in the detail page's Prompt panel and in `title`s.
 */
export function runTitle(prompt: string, max = 80): string {
  const line = prompt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "(empty prompt)";
  const clean = line
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/^[-*]\s+/, "");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "") + "…";
}

/** "/Users/me/Documents/x" → "~/Documents/x" for display; the full value belongs in Copy buttons. */
export function tildePath(p: string | null | undefined, home: string): string {
  if (!p) return "–";
  if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
  return p;
}

/** Same as tildePath but for every occurrence inside free text (commands, log lines). */
export function tildeText(text: string, home: string): string {
  if (!home) return text;
  return text
    .split(home + "/")
    .join("~/")
    .split(home)
    .join("~");
}

/** "1.2k", "840" */
export function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
