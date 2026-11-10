/**
 * `duskfleet doctor` for a human: the report `doctor --json` prints, in sections (Claude, Paths,
 * Agents, Scheduler, Budgets, Orphans, Probe). Advice lines are warnings; a missing binary or a
 * failed probe is painted as an error. Pure: the exit code stays the CLI's business.
 */
import type { BudgetState, ConfigSource, DataSource } from "@duskfleet/core";
import type { ProbeReport } from "../probe.js";
import type { KeepAwakeStatus, ServiceStatus } from "../service.js";
import { type Cell, fmtDuration, fmtUsd, kv, oneLine, type RenderOpts, section, sections } from "./primitives.js";
import { paint, type Role } from "./theme.js";

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
export const WARN_MARK = "!";

/** One advice line, painted as a warning. */
export function warnLine(text: string, opts: RenderOpts): string {
  return paint("warn", `${WARN_MARK} ${text}`, opts);
}

const yesNo = (v: boolean, noRole: Role | null = "muted"): Cell => (v ? "yes" : { text: "no", role: noRole });

const BUDGET_ROLE: Readonly<Record<BudgetState, Role>> = { ok: "ok", warn: "warn", over: "bad" };

function claudeSection(r: DoctorReport, opts: RenderOpts): string[] {
  const lines = kv(
    [
      ["binary", r.claudeBinary],
      ["version", r.claudeVersion ?? (r.error ? { text: "unknown", role: "bad" } : "unknown")],
      ["error", r.error ? { text: oneLine(r.error), role: "bad" } : null],
      ["node", r.node],
    ],
    opts,
  );
  return section("Claude", lines, opts);
}

function pathsSection(r: DoctorReport, opts: RenderOpts): string[] {
  const candidate = (name: string, dir: string | null) =>
    paint("faint", `${name.padEnd(4)}  ${dir ?? "-"}${name === r.configSource ? "  (used)" : ""}`, opts);
  const lines = [
    ...kv(
      [
        ["config", `${r.configDir} (${r.configSource})`],
        ["data", `${r.dataDir} (${r.dataSource})`],
      ],
      opts,
    ),
    paint("muted", "config lookup, first match wins:", opts),
    `  ${candidate("env", r.configLookup.env)}`,
    `  ${candidate("repo", r.configLookup.repo)}`,
    `  ${candidate("user", r.configLookup.user)}`,
  ];
  if (r.pathDefaulted) {
    lines.push(
      paint("faint", "PATH was missing or minimal: the usual install directories were put in front for claude", opts),
    );
  }
  return section("Paths", lines, opts);
}

function agentsSection(r: DoctorReport, opts: RenderOpts): string[] {
  const dupes = r.scheduler.duplicateSchedules.map((d) => d.agentId);
  return section(
    "Agents",
    kv(
      [
        ["count", String(r.agents.length)],
        ["ids", r.agents.length ? r.agents.join(", ") : null],
        ["duplicates", dupes.length ? { text: `${dupes.join(", ")} (more than one schedule)`, role: "warn" } : null],
      ],
      opts,
    ),
    opts,
  );
}

function serviceCell(s: ServiceStatus): Cell {
  if (!s.supported) return { text: "not supported here", role: "muted" };
  if (!s.installed) return { text: s.detail, role: "warn" };
  if (s.running === false) return { text: s.detail, role: "bad" };
  return { text: s.detail, role: s.running ? "ok" : null };
}

function keepAwakeCell(k: KeepAwakeStatus | null): Cell | null {
  if (!k || k.wrapsCaffeinate === null) return null;
  const sleeps =
    k.sleepMinutes === null
      ? ""
      : k.sleepMinutes === 0
        ? ", Mac sleep never"
        : `, Mac sleeps after ${k.sleepMinutes} min idle`;
  return k.wrapsCaffeinate ? { text: `yes (caffeinate)${sleeps}`, role: null } : { text: `no${sleeps}`, role: "warn" };
}

function schedulerSection(r: DoctorReport, opts: RenderOpts): string[] {
  const s = r.scheduler;
  const h = s.holder;
  const lines = kv(
    [
      ["enabled", yesNo(s.enabled, "warn")],
      [
        "ticking",
        s.ticking
          ? `yes (${h ? `${h.role}@${h.host}${h.pid === null ? "" : ` pid ${h.pid}`}` : "holder unknown"})`
          : { text: "no", role: "warn" },
      ],
      ["service", serviceCell(s.service)],
      ["service pid", s.service.pid === null ? null : String(s.service.pid)],
      ["keep awake", keepAwakeCell(s.keepAwake)],
    ],
    opts,
  );
  const advice = [s.advice, s.keepAwake?.advice ?? null, ...s.duplicateSchedules.map((d) => d.warning)].filter(
    (a): a is string => !!a,
  );
  return section("Scheduler", [...lines, ...advice.map((a) => warnLine(a, opts))], opts);
}

function budgetsSection(r: DoctorReport, opts: RenderOpts): string[] {
  const lines = r.unpricedRuns.flatMap((b) => [
    `${paint("accent", b.budget, opts)}  ${b.runs.length} unpriced run(s), counted ${fmtUsd(b.countedUsd)} / ${fmtUsd(b.amountUsd)} ${paint(BUDGET_ROLE[b.state], b.state, opts)}`,
    warnLine(b.advice, opts),
  ]);
  return section("Budgets", lines, opts);
}

function orphansSection(r: DoctorReport, opts: RenderOpts): string[] {
  const rec = r.orphans.recovered;
  const lines = [
    ...kv([["recovered", rec.length ? { text: String(rec.length), role: "warn" } : "0"]], opts),
    ...rec.map((o) => `  ${paint("accent", o.id, opts)}  ${o.agentId}, was ${o.was}`),
    ...(r.orphans.advice ? [warnLine(r.orphans.advice, opts)] : []),
  ];
  return section("Orphans", lines, opts);
}

function probeSection(p: ProbeReport | null | undefined, opts: RenderOpts): string[] {
  if (!p) return [];
  const lines = [
    ...kv(
      [
        ["outcome", { text: p.ok ? `${p.outcome}, ok` : p.outcome, role: p.ok ? "ok" : "bad" }],
        ["model", p.model],
        ["duration", p.durationMs ? fmtDuration(p.durationMs) : null],
        ["cost", p.costUsd === null ? null : fmtUsd(p.costUsd)],
        ["result", p.resultText ? oneLine(p.resultText, 120) : null],
        ["error", p.error ? { text: oneLine(p.error), role: "bad" } : null],
        ["lingered", p.lingeredAfterResult ? { text: "yes: kept running after its result", role: "bad" } : null],
      ],
      opts,
    ),
    ...(p.advice ? [warnLine(p.advice, opts)] : []),
    paint("faint", p.note, opts),
  ];
  return section("Probe", lines, opts);
}

export function renderDoctor(report: DoctorReport, opts: RenderOpts): string[] {
  return sections([
    claudeSection(report, opts),
    pathsSection(report, opts),
    agentsSection(report, opts),
    schedulerSection(report, opts),
    budgetsSection(report, opts),
    orphansSection(report, opts),
    probeSection(report.probe, opts),
  ]);
}
