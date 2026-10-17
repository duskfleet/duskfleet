export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Offset inside a run, e.g. "+0.0s", "+12.4s", "+2m 05s". */
export function fmtOffset(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `+${m}m ${String(s).padStart(2, "0")}s`;
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "–";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString();
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
  const sameDay = t.getFullYear() === today.getFullYear() && t.getMonth() === today.getMonth() && t.getDate() === today.getDate();
  if (sameDay) return h < 6 ? `${h} h ago` : `today ${clock}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (t.getFullYear() === yesterday.getFullYear() && t.getMonth() === yesterday.getMonth() && t.getDate() === yesterday.getDate()) return `yesterday ${clock}`;
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

/** Page header date: "Sunday 12 Oct · 21:08". */
export function fmtToday(now = new Date()): string {
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  const date = now.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${weekday} ${date} · ${clock(now)}`;
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

/** "claude-haiku-5-5" → "haiku 5.5"; "claude-haiku-4-5-20251001" → "haiku 4.5"; aliases pass through. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "default";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
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
  const clean = line.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/^[-*]\s+/, "");
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
  return text.split(home + "/").join("~/").split(home).join("~");
}

/** "1.2k", "840" */
export function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
