/**
 * The /attention page and the nav badge (DS-28, issue #69): everything that needs a human, as
 * items grouped by kind in a fixed order. A pure view of what the database already says (stored
 * `reviewReasons`, `errorCode`, schedule rows and firings, budget statuses): no dismiss, no
 * state of its own. An item leaves when its cause is fixed, or when it is older than the window.
 *
 * Pure (no database, no `server-only`): lib/data.ts reads the inputs, the tests feed them.
 */
import {
  type BudgetStatus,
  CLAUDE_NOT_FOUND_FIX,
  FAILURE_FIXES,
  type FailureCode,
  isClaudeNotFound,
  isOrphaned,
  REVIEW_REASON_LABELS,
  type Run,
  type Schedule,
  type ScheduleFiring,
} from "@duskfleet/core";

/** Items older than this are absent (owner decision on #69: 48 hours, not 7 days). */
export const ATTENTION_WINDOW_MS = 48 * 3600_000;
/**
 * A schedule whose last firings in a row were all `skipped_busy`, at least this many times
 * (`deferred` rows in between do not break the streak: they precede each `skipped_busy`).
 */
export const BUSY_STREAK_MIN = 3;

/** Fixed order of the sections; empty ones are hidden. */
export const SECTION_KINDS = ["login", "failed", "review", "schedules", "budgets", "busy"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const SECTION_TITLES: Record<SectionKind, string> = {
  login: "Login and quota errors",
  failed: "Failed runs",
  review: "Needs review",
  schedules: "Schedules paused or in error",
  budgets: "Budget warnings",
  busy: "Repeated skipped busy",
};

export type Tone = "bad" | "warn" | "neutral";

/** The codes of the login section: setup errors of the whole machine, not of one agent. */
export type LoginCode = "auth_required" | "provider_quota" | "claude_not_found";

/** The fix text "How to fix" opens: core's `FAILURE_FIXES`, one place with the CLI's hint table. */
export const LOGIN_FIXES: Record<LoginCode, string> = {
  auth_required: FAILURE_FIXES.auth_required,
  provider_quota: FAILURE_FIXES.provider_quota,
  claude_not_found: CLAUDE_NOT_FOUND_FIX,
};

const LOGIN_LABELS: Record<LoginCode, { badge: string; summary: string }> = {
  auth_required: { badge: "Login error", summary: "Not logged in" },
  provider_quota: { badge: "Quota", summary: "Usage limit reached" },
  claude_not_found: { badge: "Claude not found", summary: "Claude Code not found" },
};

export interface LoginItem {
  kind: "login";
  key: string;
  tone: "bad";
  code: LoginCode;
  badge: string;
  /** "claude CLI · 3 agents" */
  title: string;
  detail: string;
  agents: string[];
  runs: number;
  /** The newest run it folds in. */
  runId: string;
  at: string;
  fix: string;
}

export interface RunItem {
  kind: "failed" | "review";
  key: string;
  tone: "bad" | "warn";
  /** "Timed out", "Timed out ×5", "Needs review ×2" */
  badge: string;
  agentId: string;
  project: string;
  detail: string;
  model: string | null;
  durationMs: number | null;
  /** The newest run of the agent in this section; the row opens it. */
  runId: string;
  /** How many of the agent's runs the item folds in. */
  count: number;
  at: string;
}

export interface ScheduleItem {
  kind: "schedules";
  key: string;
  tone: "bad" | "warn";
  badge: string;
  scheduleId: string;
  name: string;
  agentId: string;
  detail: string;
  /** When it was auto-paused, or the errored firing. */
  at: string;
  /** Next cron occurrence: what resuming it would fire next. */
  nextAt: string | null;
}

export interface BudgetItem {
  kind: "budgets";
  key: string;
  tone: "bad" | "warn";
  badge: string;
  /** "global · November" */
  title: string;
  detail: string;
  countedUsd: number;
  amountUsd: number;
}

export interface BusyItem {
  kind: "busy";
  key: string;
  tone: "neutral";
  badge: string;
  scheduleId: string;
  name: string;
  agentId: string;
  streak: number;
  detail: string;
  at: string;
}

export type AttentionItem = LoginItem | RunItem | ScheduleItem | BudgetItem | BusyItem;

interface ItemsByKind {
  login: LoginItem;
  failed: RunItem;
  review: RunItem;
  schedules: ScheduleItem;
  budgets: BudgetItem;
  busy: BusyItem;
}

export interface AttentionSection<K extends SectionKind = SectionKind> {
  kind: K;
  title: string;
  items: Array<ItemsByKind[K]>;
}

/** What the nav badge shows: the number of items (causes, never runs) and its colour. */
export interface AttentionBadge {
  count: number;
  tone: "bad" | "warn";
}

export type AttentionRun = Pick<
  Run,
  | "id"
  | "agentId"
  | "status"
  | "createdAt"
  | "endedAt"
  | "durationMs"
  | "toolCalls"
  | "modelUsed"
  | "modelRequested"
  | "error"
  | "errorCode"
  | "reviewReasons"
  | "deniedTools"
> & { projectLabel: string };

export type AttentionSchedule = Pick<
  Schedule,
  "id" | "name" | "agentId" | "enabled" | "pausedReason" | "autoPausedAt" | "lastOutcome" | "lastError" | "lastFiredAt"
> & {
  /** Next cron occurrence from now, whether paused or not (null when the cron does not parse). */
  theoreticalNextAt: string | null;
  /** Newest first. */
  firings: Array<Pick<ScheduleFiring, "firedAt" | "outcome">>;
};

export type AttentionBudget = Pick<
  BudgetStatus,
  | "id"
  | "scope"
  | "scopeId"
  | "amountUsd"
  | "warnPercent"
  | "hardStop"
  | "countedUsd"
  | "percent"
  | "state"
  | "periodStart"
>;

export interface AttentionInput {
  now: number;
  /** Ended runs (kind `run`), any agent, newest first. Older than the window are dropped here too. */
  runs: AttentionRun[];
  schedules: AttentionSchedule[];
  /** Every budget with its status; the ones under their warning are dropped here. */
  budgets: AttentionBudget[];
}

const at = (r: AttentionRun) => r.endedAt ?? r.createdAt;
const newestFirst = <T extends { at: string }>(a: T, b: T) => b.at.localeCompare(a.at);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The login-section code of a run, or null: a setup error of the machine rather than of the agent. */
export function loginCode(run: Pick<Run, "status" | "error" | "errorCode">): LoginCode | null {
  if (run.errorCode === "auth_required" || run.errorCode === "provider_quota") return run.errorCode;
  if (run.status === "failed" && isClaudeNotFound(run.error)) return "claude_not_found";
  return null;
}

/** Completed with no stored review reason: the run that clears its agent's earlier items. */
function isClean(run: AttentionRun): boolean {
  return run.status === "completed" && run.reviewReasons.length === 0;
}

function minutes(ms: number | null): string {
  return ms === null ? "?" : plural(Math.max(1, Math.round(ms / 60_000)), "min", "min");
}

function failedBadge(run: AttentionRun): string {
  if (isOrphaned(run)) return "Orphaned";
  if (run.status === "timed_out") return "Timed out";
  return "Failed";
}

function firstLine(text: string, max = 200): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

function failedDetail(run: AttentionRun): string {
  if (run.status === "timed_out") {
    return `Timed out after ${minutes(run.durationMs)}, ${plural(run.toolCalls ?? 0, "tool call")}`;
  }
  if (run.error) return firstLine(run.error);
  return run.errorCode ? `Failed: ${run.errorCode as FailureCode}` : "Failed";
}

function reviewDetail(run: AttentionRun): string {
  const labels = run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]);
  const denied = [...new Set(run.deniedTools.map((d) => d.tool))];
  const head = `Completed with: ${labels.join(", ")}`;
  return denied.length ? `${head} (${denied.join(", ")} refused)` : head;
}

function loginItems(runs: AttentionRun[]): { items: LoginItem[]; folded: Set<string> } {
  const folded = new Set<string>();
  const byCode = new Map<LoginCode, AttentionRun[]>();
  const done = new Set<LoginCode>();
  // Newest first: a code's runs count until a later run (any agent) ended without that code.
  for (const run of runs) {
    const code = loginCode(run);
    for (const c of ["auth_required", "provider_quota", "claude_not_found"] as const) {
      if (c !== code) done.add(c);
    }
    if (!code || done.has(code)) continue;
    byCode.set(code, [...(byCode.get(code) ?? []), run]);
  }
  const items: LoginItem[] = [];
  for (const [code, list] of byCode) {
    for (const r of list) folded.add(r.id);
    const agents = [...new Set(list.map((r) => r.agentId))];
    const label = LOGIN_LABELS[code];
    items.push({
      kind: "login",
      key: `login:${code}`,
      tone: "bad",
      code,
      badge: label.badge,
      title: `claude CLI · ${plural(agents.length, "agent")}`,
      detail: `${label.summary}: ${plural(list.length, "run")} failed with ${code} (${agents.join(", ")})`,
      agents,
      runs: list.length,
      runId: list[0]!.id,
      at: at(list[0]!),
      fix: LOGIN_FIXES[code],
    });
  }
  return { items: items.sort(newestFirst), folded };
}

function runItems(
  runs: AttentionRun[],
  folded: Set<string>,
  handPaused: Set<string>,
): { failed: RunItem[]; review: RunItem[] } {
  const byAgent = new Map<string, AttentionRun[]>();
  for (const r of runs) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
  const failed: RunItem[] = [];
  const review: RunItem[] = [];
  for (const [agentId, list] of byAgent) {
    // A schedule paused by hand means someone already looked at this agent.
    if (handPaused.has(agentId)) continue;
    const clean = list.findIndex(isClean);
    const open = (clean === -1 ? list : list.slice(0, clean)).filter((r) => !folded.has(r.id));
    const bad = open.filter((r) => r.status === "failed" || r.status === "timed_out");
    const warn = open.filter((r) => r.status === "completed" && r.reviewReasons.length > 0);
    const item = (kind: "failed" | "review", group: AttentionRun[]): RunItem => {
      const head = group[0]!;
      const label = kind === "failed" ? failedBadge(head) : "Needs review";
      return {
        kind,
        key: `${kind}:${agentId}`,
        tone: kind === "failed" ? "bad" : "warn",
        badge: group.length > 1 ? `${label} ×${group.length}` : label,
        agentId,
        project: head.projectLabel,
        detail: kind === "failed" ? failedDetail(head) : reviewDetail(head),
        model: head.modelUsed ?? head.modelRequested,
        durationMs: head.durationMs,
        runId: head.id,
        count: group.length,
        at: at(head),
      };
    };
    if (bad.length) failed.push(item("failed", bad));
    if (warn.length) review.push(item("review", warn));
  }
  return { failed: failed.sort(newestFirst), review: review.sort(newestFirst) };
}

function scheduleItems(schedules: AttentionSchedule[], since: number): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  for (const s of schedules) {
    if (!s.enabled && s.pausedReason) {
      const when = s.autoPausedAt ?? s.lastFiredAt;
      if (!when || Date.parse(when) < since) continue;
      items.push({
        kind: "schedules",
        key: `schedule:${s.id}`,
        tone: "warn",
        badge: "Auto-paused",
        scheduleId: s.id,
        name: s.name,
        agentId: s.agentId,
        detail: s.pausedReason,
        at: when,
        nextAt: s.theoreticalNextAt,
      });
    } else if (s.enabled && s.lastOutcome === "error" && s.lastFiredAt && Date.parse(s.lastFiredAt) >= since) {
      items.push({
        kind: "schedules",
        key: `schedule:${s.id}`,
        tone: "bad",
        badge: "Error",
        scheduleId: s.id,
        name: s.name,
        agentId: s.agentId,
        detail: s.lastError ? firstLine(s.lastError) : "The last firing failed",
        at: s.lastFiredAt,
        nextAt: s.theoreticalNextAt,
      });
    }
  }
  return items.sort(newestFirst);
}

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });
const usd = (n: number) => `$${n.toFixed(2)}`;

function budgetItems(budgets: AttentionBudget[]): BudgetItem[] {
  return budgets
    .filter((b) => b.state !== "ok")
    .sort((a, b) => b.percent - a.percent)
    .map((b) => {
      const spent = b.state === "over" && b.hardStop;
      return {
        kind: "budgets",
        key: `budget:${b.id}`,
        tone: spent ? "bad" : "warn",
        badge: `Budget ${Math.round(b.percent)} %`,
        title: `${b.scope === "global" ? "global" : `${b.scope} ${b.scopeId}`} · ${MONTH.format(new Date(b.periodStart))}`,
        detail:
          `${usd(b.countedUsd)} of ${usd(b.amountUsd)} spent; warns at ${b.warnPercent} %, ` +
          (b.hardStop ? (spent ? "hard stop reached: new runs are refused" : "hard stop at 100 %") : "no hard stop"),
        countedUsd: b.countedUsd,
        amountUsd: b.amountUsd,
      };
    });
}

function busyItems(schedules: AttentionSchedule[], since: number): BusyItem[] {
  const items: BusyItem[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    // Under scheduler.defer_busy a busy tick writes a `deferred` row and the `skipped_busy`
    // row only comes when that deferral expires: skip deferred rows, stop at anything else.
    let streak = 0;
    let last: AttentionSchedule["firings"][number] | undefined;
    for (const f of s.firings) {
      if (f.outcome === "deferred") continue;
      if (f.outcome !== "skipped_busy") break;
      last ??= f;
      streak++;
    }
    if (streak < BUSY_STREAK_MIN || !last || Date.parse(last.firedAt) < since) continue;
    items.push({
      kind: "busy",
      key: `busy:${s.id}`,
      tone: "neutral",
      badge: `Skipped busy ×${streak}`,
      scheduleId: s.id,
      name: s.name,
      agentId: s.agentId,
      streak,
      detail: `${streak} fires in a row skipped: the agent or project was still busy with an earlier run`,
      at: last.firedAt,
    });
  }
  return items.sort(newestFirst);
}

/** The sections in their fixed order, empty ones dropped. */
export function attentionSections(input: AttentionInput): AttentionSection[] {
  const since = input.now - ATTENTION_WINDOW_MS;
  const runs = input.runs.filter((r) => Date.parse(at(r)) >= since);
  const handPaused = new Set(input.schedules.filter((s) => !s.enabled && !s.pausedReason).map((s) => s.agentId));
  const login = loginItems(runs);
  const { failed, review } = runItems(runs, login.folded, handPaused);
  const byKind: { [K in SectionKind]: Array<ItemsByKind[K]> } = {
    login: login.items,
    failed,
    review,
    schedules: scheduleItems(input.schedules, since),
    budgets: budgetItems(input.budgets),
    busy: busyItems(input.schedules, since),
  };
  return SECTION_KINDS.filter((k) => byKind[k].length > 0).map(
    (kind) => ({ kind, title: SECTION_TITLES[kind], items: byKind[kind] }) as AttentionSection,
  );
}

/** Coral when a login/quota item or a spent hard-stop budget is present, amber otherwise; null at 0. */
export function attentionBadge(sections: AttentionSection[]): AttentionBadge | null {
  const items = sections.flatMap((s) => s.items as AttentionItem[]);
  if (items.length === 0) return null;
  const coral = items.some((i) => i.kind === "login" || (i.kind === "budgets" && i.tone === "bad"));
  return { count: items.length, tone: coral ? "bad" : "warn" };
}

const CHIP_NOUNS: Record<SectionKind, [string, string]> = {
  login: ["login error", "login errors"],
  failed: ["failed run", "failed runs"],
  review: ["needs review", "need review"],
  schedules: ["schedule paused", "schedules paused"],
  budgets: ["budget warning", "budget warnings"],
  busy: ["skipped busy", "skipped busy"],
};

/** The summary chips under the title: "1 login error", "6 failed runs", ... with the section's tone. */
export function summaryChips(sections: AttentionSection[]): Array<{ kind: SectionKind; label: string; tone: Tone }> {
  return sections.map((s) => {
    const n = s.items.length;
    const [one, many] = CHIP_NOUNS[s.kind];
    const tone: Tone =
      s.kind === "login" || s.kind === "failed"
        ? "bad"
        : s.kind === "busy"
          ? "neutral"
          : (s.items as AttentionItem[]).some((i) => i.tone === "bad")
            ? "bad"
            : "warn";
    return { kind: s.kind, label: `${n} ${n === 1 ? one : many}`, tone };
  });
}
