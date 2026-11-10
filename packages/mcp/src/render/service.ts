/**
 * `install-service` and `uninstall-service` for a human: what was written and what the service
 * manager says now. `install-service --print` keeps printing the raw unit, not through here.
 */
import type { ServicePlatform, ServiceStatus } from "../service.js";
import { type Cell, kv, type RenderOpts } from "./primitives.js";
import { paint } from "./theme.js";

export interface ServiceInstalled {
  installed: true;
  platform: ServicePlatform;
  label: string;
  unitPath: string;
  logPath: string;
  keepAwake: boolean;
  ran: string[];
  status: ServiceStatus;
  notes: string[];
}

export interface ServiceUninstalled {
  uninstalled: true;
  removed: boolean;
  ran: string[];
}

const MANAGER: Readonly<Record<ServicePlatform, string>> = {
  darwin: "launchd",
  linux: "systemd --user",
  win32: "Task Scheduler",
};

function statusCell(s: ServiceStatus): Cell {
  if (s.running === true) return { text: s.detail, role: "ok" };
  if (s.running === false) return { text: s.detail, role: "bad" };
  return { text: s.detail, role: "warn" };
}

export function renderServiceInstalled(v: ServiceInstalled, opts: RenderOpts): string[] {
  const lines = [
    `service ${paint("accent", v.label, opts)} installed (${MANAGER[v.platform]})`,
    "",
    ...kv(
      [
        ["status", statusCell(v.status)],
        ["unit", v.unitPath],
        ["log", v.logPath],
        ["keep awake", v.platform === "darwin" ? (v.keepAwake ? "yes (caffeinate -i -s)" : "no") : null],
      ],
      opts,
    ),
  ];
  if (v.ran.length > 0) {
    lines.push("", paint("muted", "ran:", opts), ...v.ran.map((c) => `  ${paint("faint", c, opts)}`));
  }
  if (v.notes.length > 0) {
    lines.push("", paint("muted", "notes:", opts), ...v.notes.map((n) => `  - ${n}`));
  }
  return lines;
}

export function renderServiceUninstalled(v: ServiceUninstalled, _opts: RenderOpts): string[] {
  return [v.removed ? "service uninstalled: unit file removed" : "service uninstalled: no unit file was present"];
}
