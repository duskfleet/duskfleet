/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) with an IANA
 * time zone. No dependency: Duskfleet only needs "weekdays at :30, 08–20,
 * London time", not Quartz.
 *
 * Supported per field: `*`, `N`, `A-B`, `A,B,C`, `* /S` and `A-B/S` steps, names
 * for months (jan–dec) and weekdays (sun–sat). Day-of-week 7 = Sunday. When both
 * day-of-month and day-of-week are restricted, either one matching fires
 * (standard cron semantics).
 *
 * `nextFire` walks forward one minute (or one hour when the hour cannot match)
 * and re-derives the local time of each candidate through Intl, so DST shifts
 * cannot make it skip a valid instant.
 */

export interface CronSpec {
  expression: string;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export class CronError extends Error {}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `cron expression must have 5 fields (minute hour day month weekday), got ${fields.length}: "${expression}"`,
    );
  }
  const [min, hr, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    expression: fields.join(" "),
    minute: parseField(min, 0, 59, null, "minute"),
    hour: parseField(hr, 0, 23, null, "hour"),
    dayOfMonth: parseField(dom, 1, 31, null, "day-of-month"),
    month: parseField(mon, 1, 12, MONTHS, "month"),
    dayOfWeek: normalizeDow(parseField(dow, 0, 7, DAYS, "day-of-week")),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function normalizeDow(set: Set<number>): Set<number> {
  if (set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  return set;
}

function parseField(field: string, min: number, max: number, names: string[] | null, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part.trim());
    if (!m) throw new CronError(`invalid ${label} field "${part}" in "${field}"`);
    const [, rangeRaw, stepRaw] = m;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new CronError(`invalid step "${stepRaw}" in ${label}`);
    let lo: number;
    let hi: number;
    if (rangeRaw === "*") {
      lo = min;
      hi = max;
    } else if (rangeRaw!.includes("-")) {
      const [a, b] = rangeRaw!.split("-") as [string, string];
      lo = toNumber(a, names, min, max, label);
      hi = toNumber(b, names, min, max, label);
      if (lo > hi) throw new CronError(`range "${rangeRaw}" is reversed in ${label}`);
    } else {
      lo = toNumber(rangeRaw!, names, min, max, label);
      hi = stepRaw ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new CronError(`empty ${label} field`);
  return out;
}

function toNumber(token: string, names: string[] | null, min: number, max: number, label: string): number {
  let n: number;
  if (/^\d+$/.test(token)) n = Number(token);
  else if (names) {
    const i = names.indexOf(token.toLowerCase().slice(0, 3));
    if (i < 0) throw new CronError(`unknown name "${token}" in ${label}`);
    n = names === MONTHS ? i + 1 : i;
  } else throw new CronError(`"${token}" is not a number in ${label}`);
  if (n < min || n > max) throw new CronError(`${label} value ${n} out of range ${min}-${max}`);
  return n;
}

// ---- time zone helpers ----------------------------------------------------------

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
      });
    } catch {
      throw new CronError(`unknown time zone "${timeZone}"`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: DAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)),
  };
}

function matches(spec: CronSpec, p: LocalParts): boolean {
  if (!spec.minute.has(p.minute) || !spec.hour.has(p.hour) || !spec.month.has(p.month)) return false;
  const domOk = spec.dayOfMonth.has(p.day);
  const dowOk = spec.dayOfWeek.has(p.weekday);
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * First instant strictly after `after` that matches the spec in `timeZone`.
 * Returns null when nothing matches within `horizonDays`.
 */
export function nextFire(spec: CronSpec, after: Date, timeZone: string, horizonDays = 400): Date | null {
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE; // next whole minute
  const limit = after.getTime() + horizonDays * 24 * HOUR;
  while (t <= limit) {
    const d = new Date(t);
    const p = localParts(d, timeZone);
    if (matches(spec, p)) return d;
    // Nothing in this hour can match: jump to the next hour boundary (DST-safe, re-derived each loop).
    if (!spec.hour.has(p.hour) || !spec.month.has(p.month)) t += (60 - p.minute) * MINUTE;
    else t += MINUTE;
  }
  return null;
}

/** Human-ish description for dashboards, e.g. "weekdays 08–20 at :30". Falls back to the expression. */
export function describeCron(spec: CronSpec): string {
  const list = (s: Set<number>) => [...s].sort((a, b) => a - b);
  const dows = list(spec.dayOfWeek);
  const hours = list(spec.hour);
  const minutes = list(spec.minute);
  let days: string;
  if (!spec.dowRestricted && !spec.domRestricted) days = "every day";
  else if (spec.dowRestricted && !spec.domRestricted) {
    if (dows.join() === "1,2,3,4,5") days = "weekdays";
    else if (dows.join() === "0,6") days = "weekends";
    else days = dows.map((d) => DAYS[d]!).join(",");
  } else return spec.expression;
  if (!spec.month.size || spec.month.size !== 12) return spec.expression;
  let when: string;
  if (minutes.length === 1 && hours.length === 1) when = `at ${pad(hours[0]!)}:${pad(minutes[0]!)}`;
  else if (minutes.length === 1 && isContiguous(hours))
    when = `${pad(hours[0]!)}–${pad(hours[hours.length - 1]!)} at :${pad(minutes[0]!)}`;
  else if (minutes.length === 1 && hours.length === 24) when = `hourly at :${pad(minutes[0]!)}`;
  else return spec.expression;
  return `${days} ${when}`;
}

function isContiguous(xs: number[]): boolean {
  return xs.every((v, i) => i === 0 || v === xs[i - 1]! + 1);
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
