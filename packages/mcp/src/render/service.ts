/**
 * `install-service` and `uninstall-service` for a human (DS-33 acknowledgements): one glyph line
 * with what the service manager says now, then at most two indented lines (the file written, the
 * command that checks it). `--json` keeps the commands run and the notes; `install-service --print`
 * keeps printing the raw unit, not through here.
 */
import type { ServicePlatform, ServiceStatus } from "../service.js";
import type { RenderOpts } from "./primitives.js";
import { GLYPH, paint } from "./theme.js";

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

export function renderServiceInstalled(v: ServiceInstalled, opts: RenderOpts): string[] {
  const failed = v.status.running === false;
  const glyph = failed ? paint("bad", GLYPH.bad, opts) : paint("ok", GLYPH.ok, opts);
  const awake = v.platform === "darwin" ? (v.keepAwake ? ", keep awake" : ", may sleep") : "";
  return [
    `${glyph} service ${paint("accent", v.label, opts)} installed (${MANAGER[v.platform]}${awake}) · ${failed ? paint("bad", v.status.detail, opts) : v.status.detail}`,
    `  wrote ${v.unitPath} · log ${v.logPath}`,
    `  check it: ${paint("accent", "duskfleet doctor", opts)}`,
  ];
}

export function renderServiceUninstalled(v: ServiceUninstalled, opts: RenderOpts): string[] {
  return [
    `${paint("ok", GLYPH.ok, opts)} service uninstalled`,
    v.removed ? "  removed the unit file" : "  no unit file was present",
  ];
}
