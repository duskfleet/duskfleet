/**
 * Why a run failed, as a code a program can act on instead of a sentence to read.
 *
 * Same rule as `looksLikeContextExhaustion`: only structured signals count. The result
 * line's `terminal_reason` / `subtype` / `stop_reason`, and the error text of a run that
 * *failed* (Claude Code's own error message, or the stderr tail when there was no result
 * line). A successful run's prose is never scanned: an agent writing "429" or "not logged
 * in" in a report is not a failure.
 *
 * Codes, grouped in families by what a human (or a scheduler) does about them:
 *   setup      auth_required (Claude is not logged in), model_not_found
 *   limit      max_turns_exhausted, provider_quota (with `retryNotBefore` when the message says when)
 *   transient  transient_upstream (429 / 503 / 529 / overloaded): retrying later may work
 *   refusal    refusal (`stop_reason: refusal`), even on a run that exited 0
 */

export const FAILURE_CODES = [
  "auth_required",
  "model_not_found",
  "max_turns_exhausted",
  "provider_quota",
  "transient_upstream",
  "refusal",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export type FailureFamily = "setup" | "limit" | "transient" | "refusal";

export const FAILURE_FAMILY: Record<FailureCode, FailureFamily> = {
  auth_required: "setup",
  model_not_found: "setup",
  max_turns_exhausted: "limit",
  provider_quota: "limit",
  transient_upstream: "transient",
  refusal: "refusal",
};

export const FAILURE_LABELS: Record<FailureCode, string> = {
  auth_required: "Claude is not logged in",
  model_not_found: "model not found",
  max_turns_exhausted: "max turns reached",
  provider_quota: "usage limit reached",
  transient_upstream: "API overloaded or unavailable",
  refusal: "the model refused",
};

/** Extra facts some codes carry. Stored as `error_detail_json`. */
export interface FailureDetail {
  /** auth_required: the login URL the error message gave, when it gave one. */
  loginUrl?: string;
  /** provider_quota: ISO time the quota resets, parsed from "resets at ..." / "limit reached|<epoch>". */
  retryNotBefore?: string;
}

export interface FailureClassification {
  code: FailureCode;
  family: FailureFamily;
  detail: FailureDetail | null;
}

export interface FailureInput {
  outcome: "completed" | "failed" | "cancelled" | "timed_out";
  /** The run's error: the result's error text, or the exit code / stderr tail without one. */
  error: string | null;
  terminalReason: string | null;
  subtype: string | null;
  stopReason: string | null;
  /** When the run ended: the reference for relative reset times ("resets 3pm"). */
  endedAt: Date;
}

/** How much of the error text is looked at: Claude Code's message comes first, the stderr tail after it. */
const ERROR_SCAN_CHARS = 2000;

/** Null when the run did not fail in a way this knows, or did not fail at all. */
export function classifyFailure(input: FailureInput): FailureClassification | null {
  const make = (code: FailureCode, detail: FailureDetail | null = null): FailureClassification => ({
    code,
    family: FAILURE_FAMILY[code],
    detail,
  });

  // A refusal can end a run that exits 0: the stop reason is structured, so it counts on any outcome.
  if (input.stopReason?.toLowerCase() === "refusal") return make("refusal");
  if (input.outcome !== "failed") return null;

  const structured = [input.terminalReason, input.subtype]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase();
  if (/max[_ ]turns/.test(structured)) return make("max_turns_exhausted");

  const err = (input.error ?? "").slice(0, ERROR_SCAN_CHARS);
  if (!err) return null;

  if (
    /not logged in|please run \/login|invalid api key|authentication_error|oauth token (?:has )?(?:expired|been revoked)/i.test(
      err,
    )
  ) {
    const url = /https?:\/\/[^\s"'<>)]+/.exec(err)?.[0];
    return make("auth_required", url ? { loginUrl: url.replace(/[.,;]+$/, "") } : null);
  }
  if (
    /issue with the selected model|model[^\n]{0,80}(?:not found|does not exist|may not exist)|not_found_error[^\n]{0,80}model/i.test(
      err,
    )
  ) {
    return make("model_not_found");
  }
  // "Rate limit reached" is a 429 (transient), not the account's usage limit.
  if (/usage limit|hit your (?:\w+ )?limit|(?<!rate )limit reached|out of extra usage|\bquota\b/i.test(err)) {
    const at = parseResetTime(err, input.endedAt);
    return make("provider_quota", at ? { retryNotBefore: at } : null);
  }
  if (/\b(?:429|503|529)\b|overloaded|rate_limit_error/i.test(err)) return make("transient_upstream");
  return null;
}

/**
 * The reset time a quota message states, as an ISO string; null when it states none this can read.
 * Forms: `limit reached|1760000000` (epoch seconds), `resets at 2026-10-21T15:00:00Z` (ISO), and
 * `resets [at] 3pm` / `resets 15:30 (Europe/London)` (wall clock, next occurrence after `now`, in the
 * given time zone or the host's).
 */
export function parseResetTime(text: string, now: Date): string | null {
  const epoch = /limit reached\s*\|\s*(\d{10})\b/i.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();

  const iso = /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]!);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  const clock =
    /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]?.toLowerCase();
  // A bare number with neither minutes nor am/pm ("resets 3 times") is not a time.
  if (!clock[2] && !meridiem) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const timeZone = clock[4] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return nextWallClock(now, hour, minute, timeZone).toISOString();
  } catch {
    return null; // unknown time zone
  }
}

/** The first instant after `now` whose wall clock in `timeZone` reads hour:minute. */
function nextWallClock(now: Date, hour: number, minute: number, timeZone: string): Date {
  const today = wallParts(now, timeZone);
  for (let addDays = 0; addDays <= 2; addDays++) {
    const t = zonedToUtc(today.year, today.month, today.day + addDays, hour, minute, timeZone);
    if (t.getTime() > now.getTime()) return t;
  }
  throw new Error("unreachable");
}

function wallParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** UTC instant of a wall-clock time in `timeZone` (two offset passes, so a DST change in between is honoured). */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = wallParts(new Date(guess), timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
    guess = wallAsUtc - offset;
  }
  return new Date(guess);
}
