/**
 * `duskfleet doctor` for a human (DS-33): a `doctor · n warnings · n errors` header, then one check
 * per line (glyph, a 16-column name, the value) in a fixed order: node, claude, PATH, config, data,
 * agents, scheduler, schedules, unpriced runs, orphans, probe. Advice lines are indented under their
 * check. A missing binary is the only error. Pure: the exit code stays the CLI's business.
 */
import type { BudgetState, ConfigSource, DataSource } from "@duskfleet/core";
import type { ProbeReport } from "../probe.js";
import type { KeepAwakeStatus, ServiceStatus } from "../service.js";
import { AGENT_CREATE } from "./agents.js";
import { fmtCents, fmtCost, fmtDuration, jsonLine, oneLine, type RenderOpts } from "./primitives.js";
import { GLYPH, paint } from "./theme.js";

export interface DoctorReport {
  node: string;
  claudeBinary: string;
  claudeVersion: string | null;
  path: string;
  pathDefaulted: boolean;
  error: string | null;
  configDir: string;
  configSource: ConfigSource;
  configLookup: { env: string | null; repo: string | null; user: string };
  dataDir: string;
  dataSource: DataSource;
  agents: string[];
  scheduler: {
    enabled: boolean;
    ticking: boolean;
    holder: { role: string; host: string; pid: number | null; expiresAt: string } | null;
    service: ServiceStatus;
    keepAwake: KeepAwakeStatus | null;
    advice: string | null;
    duplicateSchedules: { agentId: string; schedules: { id: string; name: string }[]; warning: string }[];
  };
  unpricedRuns: {
    budget: string;
    budgetId: string;
    unpricedPolicy: string;
    state: BudgetState;
    spentUsd: number;
    countedUsd: number;
    amountUsd: number;
    runs: { id: string; agentId: string; standInUsd: number | null }[];
    advice: string;
  }[];
  orphans: {
    recovered: { id: string; agentId: string; was: string; owner: string | null; createdAt: string }[];
    advice: string | null;
  };
  probe?: ProbeReport | null;
}

/** Prefix of a warning line. */
export const WARN_MARK = GLYPH.warn;

/** One advice line, glyph painted as a warning, text in the default colour. */
export function warnLine(text: string, opts: RenderOpts): string {
  return `${paint("warn", WARN_MARK, opts)} ${text}`;
}

type Level = "ok" | "warn" | "error";

interface Check {
  level: Level;
  name: string;
  /** The value, already painted. */
  value: string;
  /** Indented under the check. */
  advice?: string[];
}

const NAME = 16;

const ok = (name: string, value: string, advice: string[] = []): Check => ({ level: "ok", name, value, advice });
const warn = (name: string, value: string, advice: string[] = []): Check => ({ level: "warn", name, value, advice });

/** `spawn claude ENOENT`, `command not found`: the binary is missing, not merely failing. */
const looksMissing = (error: string) => /ENOENT|not found|no such file/i.test(error);

function claudeCheck(r: DoctorReport, opts: RenderOpts): Check {
  if (r.error) {
    const missing = looksMissing(r.error);
    const advice = [`${r.claudeBinary}: ${oneLine(r.error)}`];
    return missing
      ? { level: "error", name: "claude", value: paint("bad", "not found", opts), advice }
      : warn("claude", `version unknown · ${r.claudeBinary}`, advice);
  }
  return ok("claude", `${r.claudeVersion ?? "version unknown"} · ${r.claudeBinary}`);
}

function schedulerCheck(r: DoctorReport): Check {
  const s = r.scheduler;
  const h = s.holder;
  const ticking = s.ticking
    ? `ticking ${h ? `${h.role}@${h.host}${h.pid === null ? "" : ` pid ${h.pid}`}` : "(holder unknown)"}`
    : "nothing ticking";
  const service = s.service.supported ? `service ${s.service.detail}` : "service not supported here";
  const awake =
    s.keepAwake && s.keepAwake.wrapsCaffeinate !== null
      ? `keep awake ${s.keepAwake.wrapsCaffeinate ? "yes" : "no"}${s.keepAwake.sleepMinutes ? ` (sleeps after ${s.keepAwake.sleepMinutes} min idle)` : ""}`
      : null;
  const value = [s.enabled ? "enabled" : "disabled", ticking, service, awake].filter(Boolean).join(" · ");
  const advice = [s.advice, s.keepAwake?.advice ?? null].filter((a): a is string => !!a);
  const healthy = s.enabled && s.ticking && s.service.running !== false && advice.length === 0;
  return healthy ? ok("scheduler", value) : warn("scheduler", value, advice);
}

function probeCheck(p: ProbeReport, opts: RenderOpts): Check {
  const parts = [
    p.ok ? `${p.outcome}, ok` : p.outcome,
    p.model,
    p.durationMs ? fmtDuration(p.durationMs) : null,
    p.costUsd === null ? null : fmtCost(p.costUsd),
  ].filter(Boolean);
  const advice = [
    ...(p.error ? [oneLine(p.error)] : []),
    ...(p.lingeredAfterResult ? ["kept running after its result"] : []),
    ...(p.advice ? [p.advice] : []),
    paint("muted", p.note, opts),
  ];
  return p.ok ? ok("probe", parts.join(" · "), advice) : warn("probe", parts.join(" · "), advice);
}

function checks(r: DoctorReport, opts: RenderOpts): Check[] {
  const dupes = r.scheduler.duplicateSchedules;
  const unpriced = r.unpricedRuns.reduce((n, b) => n + b.runs.length, 0);
  const rec = r.orphans.recovered;
  const list: Check[] = [
    ok("node", r.node),
    claudeCheck(r, opts),
    r.pathDefaulted
      ? warn("PATH", "defaulted", [
          "PATH was missing or minimal: the usual install directories were put in front for claude",
        ])
      : ok("PATH", "inherited"),
    ok("config", `${r.configDir} (${r.configSource})`),
    ok("data", `${r.dataDir} (${r.dataSource})`),
    r.agents.length
      ? ok("agents", `${r.agents.length}: ${r.agents.join(", ")}`)
      : warn("agents", "none yet", [paint("accent", AGENT_CREATE, opts)]),
    schedulerCheck(r),
    dupes.length
      ? warn(
          "schedules",
          `${dupes.length} agent(s) with more than one schedule`,
          dupes.map((d) => d.warning),
        )
      : ok("schedules", "one per agent"),
    unpriced
      ? warn(
          "unpriced runs",
          `${unpriced} this month`,
          r.unpricedRuns.map(
            (b) =>
              `${b.budget}: counted ${fmtCost(b.countedUsd)} / ${fmtCents(b.amountUsd)} (${b.state}) · ${b.advice}`,
          ),
        )
      : ok("unpriced runs", "none"),
    rec.length
      ? warn("orphans", `${rec.length} recovered`, [
          ...rec.map((o) => `${paint("accent", o.id, opts)}  ${o.agentId}, was ${o.was}`),
          ...(r.orphans.advice ? [r.orphans.advice] : []),
        ])
      : ok("orphans", "none recovered"),
  ];
  if (r.probe) list.push(probeCheck(r.probe, opts));
  return list;
}

const GLYPHS: Readonly<Record<Level, [string, "ok" | "warn" | "bad"]>> = {
  ok: [GLYPH.ok, "ok"],
  warn: [GLYPH.warn, "warn"],
  error: [GLYPH.bad, "bad"],
};

export function renderDoctor(report: DoctorReport, opts: RenderOpts): string[] {
  const list = checks(report, opts);
  const warnings = list.filter((c) => c.level === "warn").length;
  const errors = list.filter((c) => c.level === "error").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [
    `${paint("heading", "doctor", opts)} · ${plural(warnings, "warning")} · ${plural(errors, "error")}`,
    "",
  ];
  for (const c of list) {
    const [glyph, role] = GLYPHS[c.level];
    lines.push(`${paint(role, glyph, opts)} ${paint("heading", c.name.padEnd(NAME), opts)}${c.value}`);
    for (const a of c.advice ?? []) lines.push(`  ${" ".repeat(NAME)}${a}`);
  }
  lines.push("", jsonLine(opts, report.probe ? undefined : "one real run on haiku: duskfleet doctor --probe"));
  return lines;
}
