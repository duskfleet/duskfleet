/**
 * Register `duskfleet serve` as a per-user service so schedules keep firing
 * when no MCP host (Claude Desktop, Claude Code) is open.
 *
 *   macOS    launchd LaunchAgent   ~/Library/LaunchAgents/com.duskfleet.scheduler.plist
 *   Linux    systemd user unit     ~/.config/systemd/user/duskfleet.service
 *   Windows  Task Scheduler task   "Duskfleet Scheduler" (logon trigger, imported from XML)
 *
 * All three run as the logged-in user (so `claude` finds its login), restart the
 * process when it dies and append its stderr to data/logs/serve.log. Nothing in
 * the scheduler changes: the service is one more lease candidate; the MCP server
 * keeps ticking as a fallback when the service is not running.
 *
 * The unit is rendered from the machine's real paths (node, dist/cli.js, the
 * repo, the claude binary) and is never versioned. `install` is idempotent and
 * restarts the service, which is also how new code is picked up after a build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

export type ServicePlatform = "darwin" | "linux" | "win32";

export interface ServiceTarget {
  platform: NodeJS.Platform;
  /** Absolute path of the repo (working directory of the service). */
  repoRoot: string;
  /**
   * Config directory exported as DUSKFLEET_CONFIG, for a config the service could not find
   * by walking up from its cli.js (an installed package, or DUSKFLEET_CONFIG set by hand).
   * Null or absent: the service finds `<repoRoot>/config` itself.
   */
  configDir?: string | null;
  /**
   * Data directory exported as DUSKFLEET_DATA, set only when the installing process got it from
   * DUSKFLEET_DATA: without it the service would open another database (data_dir or the default)
   * than the CLI and the dashboard. Null or absent: the service resolves it like the CLI does.
   */
  dataDir?: string | null;
  /** Absolute path of the node binary that runs the CLI. */
  nodeBin: string;
  /** Absolute path of packages/mcp/dist/cli.js. */
  cliEntry: string;
  /** Where the service appends its stderr/stdout. */
  logPath: string;
  /** Resolved claude binary, exported as CLAUDE_BIN so the service never depends on PATH. */
  claudeBin: string | null;
  home?: string;
  /** Windows only: account the task runs as; defaults to the current user. */
  user?: string;
}

export interface ServiceUnit {
  platform: ServicePlatform;
  label: string;
  unitPath: string;
  content: string;
  /** The commands `install` runs, for the user to read or repeat by hand. */
  installCommands: string[];
  uninstallCommands: string[];
  /** Platform caveats worth printing once. */
  notes: string[];
}

export interface ServiceStatus {
  platform: NodeJS.Platform;
  supported: boolean;
  label: string | null;
  unitPath: string | null;
  /** The unit file exists (macOS, Linux) or the task is registered (Windows). */
  installed: boolean;
  /** The service manager reports the process as running. null = could not tell. */
  running: boolean | null;
  pid: number | null;
  detail: string;
}

const LAUNCHD_LABEL = "com.duskfleet.scheduler";
const SYSTEMD_UNIT = "duskfleet.service";
const WINDOWS_TASK = "Duskfleet Scheduler";

export function isSupportedPlatform(p: NodeJS.Platform): p is ServicePlatform {
  return p === "darwin" || p === "linux" || p === "win32";
}

export function serviceLabel(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") return LAUNCHD_LABEL;
  if (platform === "linux") return SYSTEMD_UNIT;
  if (platform === "win32") return WINDOWS_TASK;
  return null;
}

export function serviceUnitPath(platform: NodeJS.Platform, home = homedir()): string | null {
  if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (platform === "linux") return path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
  if (platform === "win32") return path.join(home, "AppData", "Local", "Duskfleet", "scheduler-task.xml");
  return null;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Where the service runs and which config it reads. From a checkout (`repoRoot` found by
 * walking up from cli.js) the service runs in the repo and finds `config/` itself; the
 * resolved config is exported only when it is somewhere else. From an installed package
 * there is no repo root: the service runs in the config directory's parent and always gets
 * DUSKFLEET_CONFIG, or it would not find its config and restart in a loop.
 */
export function serviceDirs(
  repoRoot: string | null,
  configDir: string,
): { repoRoot: string; configDir: string | null } {
  const resolved = path.resolve(configDir);
  if (repoRoot) {
    return { repoRoot, configDir: resolved === path.resolve(repoRoot, "config") ? null : resolved };
  }
  return { repoRoot: path.dirname(resolved), configDir: resolved };
}

/**
 * `npx duskfleet install-service` runs from npm's temporary cache (`.../_npx/<hash>/...`):
 * a unit pointing there breaks as soon as npm evicts the cache. Refuse it.
 */
export function assertNotNpxCache(cliEntry: string): void {
  if (path.resolve(cliEntry).split(/[\\/]/).includes("_npx")) {
    throw new Error(
      `install-service refuses to register ${cliEntry}: it lives in npx's temporary cache, which npm can evict at any time. Install the package first (npm install -g duskfleet), then run "duskfleet install-service".`,
    );
  }
}

function searchPath(t: ServiceTarget, extra: string[]): string {
  const dirs = [path.dirname(t.nodeBin)];
  if (t.claudeBin) dirs.push(path.dirname(t.claudeBin));
  dirs.push(...extra);
  return [...new Set(dirs)].join(":");
}

export function renderService(t: ServiceTarget): ServiceUnit {
  const home = t.home ?? homedir();
  const unitPath = serviceUnitPath(t.platform, home);
  if (!isSupportedPlatform(t.platform) || !unitPath) {
    throw new Error(
      `install-service supports macOS (launchd), Linux (systemd --user) and Windows (Task Scheduler); this is ${t.platform}. Run "duskfleet serve" under your own supervisor instead.`,
    );
  }
  assertNotNpxCache(t.cliEntry);

  if (t.platform === "darwin") {
    const env: Array<[string, string]> = [
      ["PATH", searchPath(t, ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])],
    ];
    if (t.claudeBin) env.push(["CLAUDE_BIN", t.claudeBin]);
    if (t.configDir) env.push(["DUSKFLEET_CONFIG", t.configDir]);
    if (t.dataDir) env.push(["DUSKFLEET_DATA", t.dataDir]);
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      `    <string>${xml(t.nodeBin)}</string>`,
      `    <string>${xml(t.cliEntry)}</string>`,
      "    <string>serve</string>",
      "  </array>",
      `  <key>WorkingDirectory</key><string>${xml(t.repoRoot)}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      "  <key>ThrottleInterval</key><integer>10</integer>",
      "  <key>ProcessType</key><string>Background</string>",
      `  <key>StandardOutPath</key><string>${xml(t.logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(t.logPath)}</string>`,
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      ...env.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`),
      "  </dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    const domain = "gui/$(id -u)";
    return {
      platform: "darwin",
      label: LAUNCHD_LABEL,
      unitPath,
      content,
      installCommands: [
        `launchctl bootout ${domain}/${LAUNCHD_LABEL} 2>/dev/null`,
        `launchctl bootstrap ${domain} "${unitPath}"`,
        `launchctl kickstart -k ${domain}/${LAUNCHD_LABEL}`,
      ],
      uninstallCommands: [`launchctl bootout ${domain}/${LAUNCHD_LABEL}`, `rm "${unitPath}"`],
      notes: [
        "A LaunchAgent runs in your login session, so the service sees the same `claude` login as your terminal.",
        "The service starts at login and is restarted if it dies. While the Mac sleeps nothing runs; missed ticks are not caught up.",
        `After every \`npm run build\` run install-service again (or \`launchctl kickstart -k ${domain}/${LAUNCHD_LABEL}\`) to load the new code.`,
      ],
    };
  }

  if (t.platform === "linux") {
    const quote = (s: string) => `"${s.replace(/(["\\$])/g, "\\$1")}"`;
    const pathEnv = searchPath(t, ["/usr/local/bin", "/usr/bin", "/bin"]);
    const content = [
      "[Unit]",
      "Description=Duskfleet scheduler (duskfleet serve)",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${quote(t.nodeBin)} ${quote(t.cliEntry)} serve`,
      `WorkingDirectory=${t.repoRoot}`,
      "Restart=always",
      "RestartSec=5",
      `Environment=${quote(`PATH=${pathEnv}`)}`,
      ...(t.claudeBin ? [`Environment=${quote(`CLAUDE_BIN=${t.claudeBin}`)}`] : []),
      ...(t.configDir ? [`Environment=${quote(`DUSKFLEET_CONFIG=${t.configDir}`)}`] : []),
      ...(t.dataDir ? [`Environment=${quote(`DUSKFLEET_DATA=${t.dataDir}`)}`] : []),
      `StandardOutput=append:${t.logPath}`,
      `StandardError=append:${t.logPath}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    return {
      platform: "linux",
      label: SYSTEMD_UNIT,
      unitPath,
      content,
      installCommands: [
        "systemctl --user daemon-reload",
        `systemctl --user enable ${SYSTEMD_UNIT}`,
        `systemctl --user restart ${SYSTEMD_UNIT}`,
      ],
      uninstallCommands: [
        `systemctl --user disable --now ${SYSTEMD_UNIT}`,
        `rm "${unitPath}"`,
        "systemctl --user daemon-reload",
      ],
      notes: [
        "A systemd user unit runs in your login session, so the service sees the same `claude` login as your terminal.",
        "To keep it running when you are logged out: `loginctl enable-linger $USER`.",
        `After every \`npm run build\` run install-service again (or \`systemctl --user restart ${SYSTEMD_UNIT}\`) to load the new code.`,
      ],
    };
  }

  // win32: a logon task imported from XML. The CLI flags of schtasks cannot set
  // "no time limit" or "restart on failure"; XML can. The command goes through
  // cmd.exe so stdout/stderr can be appended to the log file.
  const user = t.user ?? windowsUser();
  // A task has no environment block: the config and data dirs are set by cmd.exe before node starts.
  const setConfig = t.configDir ? `set "DUSKFLEET_CONFIG=${t.configDir}"&& ` : "";
  const setData = t.dataDir ? `set "DUSKFLEET_DATA=${t.dataDir}"&& ` : "";
  const cmd = `/c "${setConfig}${setData}"${t.nodeBin}" "${t.cliEntry}" serve >> "${t.logPath}" 2>&1"`;
  const content = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Duskfleet scheduler (duskfleet serve). Keeps cron schedules firing while no MCP host is open.</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    ...(user ? [`      <UserId>${xml(user)}</UserId>`] : []),
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    ...(user ? [`      <UserId>${xml(user)}</UserId>`] : []),
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>true</Hidden>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>cmd.exe</Command>",
    `      <Arguments>${xml(cmd)}</Arguments>`,
    `      <WorkingDirectory>${xml(t.repoRoot)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
  return {
    platform: "win32",
    label: WINDOWS_TASK,
    unitPath,
    content,
    installCommands: [
      `schtasks /Create /F /TN "${WINDOWS_TASK}" /XML "${unitPath}"`,
      `schtasks /Run /TN "${WINDOWS_TASK}"`,
    ],
    uninstallCommands: [`schtasks /End /TN "${WINDOWS_TASK}"`, `schtasks /Delete /F /TN "${WINDOWS_TASK}"`],
    notes: [
      "A logon task in Task Scheduler runs as you, so the service sees the same `claude` login as your terminal.",
      "The task starts at logon, has no time limit and is restarted on failure. A console window may flash briefly at logon.",
      "After every `npm run build` run install-service again to restart the task with the new code.",
      "Windows support has not been exercised by the maintainers yet: if `doctor` shows the service running but schedules never fire, check data/logs/serve.log and open an issue.",
    ],
  };
}

function windowsUser(): string | null {
  const name = process.env["USERNAME"] ?? safeUserName();
  if (!name) return null;
  const domain = process.env["USERDOMAIN"];
  return domain ? `${domain}\\${name}` : name;
}

function safeUserName(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

// ---- running the service manager ----------------------------------------------

export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

export const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

function must(exec: Exec, cmd: string, args: string[], what: string): string {
  const r = exec(cmd, args);
  if (r.status !== 0)
    throw new Error(
      `${what} failed (${cmd} ${args.join(" ")}): ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`,
    );
  return r.stdout;
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

export function writeUnit(unit: ServiceUnit): void {
  mkdirSync(path.dirname(unit.unitPath), { recursive: true });
  if (unit.platform === "win32") {
    // Task Scheduler expects UTF-16LE with a BOM, matching the XML declaration.
    writeFileSync(unit.unitPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(unit.content, "utf16le")]));
  } else {
    writeFileSync(unit.unitPath, unit.content, { mode: 0o644 });
  }
}

/** Write the unit and (re)start the service. Idempotent: a loaded service is restarted with the new unit. */
export function installService(t: ServiceTarget, exec: Exec = realExec): { unit: ServiceUnit; ran: string[] } {
  const unit = renderService(t);
  mkdirSync(path.dirname(t.logPath), { recursive: true });
  writeUnit(unit);
  const ran: string[] = [];
  if (unit.platform === "darwin") {
    const d = launchdDomain();
    exec("launchctl", ["bootout", `${d}/${unit.label}`]); // not loaded yet: fine
    ran.push(`launchctl bootout ${d}/${unit.label}`);
    must(exec, "launchctl", ["bootstrap", d, unit.unitPath], "launchctl bootstrap");
    ran.push(`launchctl bootstrap ${d} ${unit.unitPath}`);
  } else if (unit.platform === "linux") {
    must(exec, "systemctl", ["--user", "daemon-reload"], "systemctl daemon-reload");
    must(exec, "systemctl", ["--user", "enable", unit.label], "systemctl enable");
    must(exec, "systemctl", ["--user", "restart", unit.label], "systemctl restart");
    ran.push(
      "systemctl --user daemon-reload",
      `systemctl --user enable ${unit.label}`,
      `systemctl --user restart ${unit.label}`,
    );
  } else {
    exec("schtasks", ["/End", "/TN", unit.label]); // stop a running instance so /Run restarts with the new code
    must(exec, "schtasks", ["/Create", "/F", "/TN", unit.label, "/XML", unit.unitPath], "schtasks /Create");
    must(exec, "schtasks", ["/Run", "/TN", unit.label], "schtasks /Run");
    ran.push(
      `schtasks /End /TN "${unit.label}"`,
      `schtasks /Create /F /TN "${unit.label}" /XML "${unit.unitPath}"`,
      `schtasks /Run /TN "${unit.label}"`,
    );
  }
  return { unit, ran };
}

export function uninstallService(
  platform: NodeJS.Platform,
  exec: Exec = realExec,
  home = homedir(),
): { removed: boolean; ran: string[] } {
  const label = serviceLabel(platform);
  const unitPath = serviceUnitPath(platform, home);
  if (!label || !unitPath) throw new Error(`no service support on ${platform}`);
  const ran: string[] = [];
  if (platform === "darwin") {
    const d = launchdDomain();
    exec("launchctl", ["bootout", `${d}/${label}`]);
    ran.push(`launchctl bootout ${d}/${label}`);
  } else if (platform === "linux") {
    exec("systemctl", ["--user", "disable", "--now", label]);
    ran.push(`systemctl --user disable --now ${label}`);
  } else {
    exec("schtasks", ["/End", "/TN", label]);
    exec("schtasks", ["/Delete", "/F", "/TN", label]);
    ran.push(`schtasks /End /TN "${label}"`, `schtasks /Delete /F /TN "${label}"`);
  }
  const removed = existsSync(unitPath);
  if (removed) rmSync(unitPath);
  if (platform === "linux") {
    exec("systemctl", ["--user", "daemon-reload"]);
    ran.push("systemctl --user daemon-reload");
  }
  return { removed, ran };
}

/** Ask the service manager whether the service is registered and running. Never throws. */
export function serviceStatus(platform: NodeJS.Platform, exec: Exec = realExec, home = homedir()): ServiceStatus {
  const label = serviceLabel(platform);
  const unitPath = serviceUnitPath(platform, home);
  if (!label || !unitPath) {
    return {
      platform,
      supported: false,
      label: null,
      unitPath: null,
      installed: false,
      running: null,
      pid: null,
      detail: `no service support on ${platform}; run "duskfleet serve" under your own supervisor`,
    };
  }
  const base = { platform, supported: true, label, unitPath };
  if (platform === "darwin") {
    const r = exec("launchctl", ["print", `${launchdDomain()}/${label}`]);
    if (r.status !== 0) {
      return {
        ...base,
        installed: existsSync(unitPath),
        running: false,
        pid: null,
        detail: existsSync(unitPath) ? "plist present but not loaded: run install-service" : "not installed",
      };
    }
    const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
    const state = /^\s*state = (\w+)/m.exec(r.stdout)?.[1] ?? "unknown";
    return {
      ...base,
      installed: true,
      running: state === "running" || !!pid,
      pid: pid ? Number(pid) : null,
      detail: `launchd: ${state}${pid ? ` pid ${pid}` : ""}`,
    };
  }
  if (platform === "linux") {
    const r = exec("systemctl", ["--user", "show", label, "--property=ActiveState,SubState,MainPID,LoadState"]);
    if (r.status !== 0)
      return {
        ...base,
        installed: existsSync(unitPath),
        running: null,
        pid: null,
        detail: `systemctl unavailable: ${(r.stderr || r.stdout).trim()}`,
      };
    const prop = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1]?.trim() ?? "";
    const loaded = prop("LoadState") === "loaded";
    const pid = Number(prop("MainPID"));
    return {
      ...base,
      installed: loaded || existsSync(unitPath),
      running: prop("ActiveState") === "active",
      pid: pid > 0 ? pid : null,
      detail: loaded ? `systemd: ${prop("ActiveState")} (${prop("SubState")})` : "not installed",
    };
  }
  const r = exec("schtasks", ["/Query", "/TN", label, "/FO", "LIST", "/V"]);
  if (r.status !== 0) return { ...base, installed: false, running: false, pid: null, detail: "not installed" };
  const status = /^Status:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() ?? "unknown";
  return { ...base, installed: true, running: /running/i.test(status), pid: null, detail: `Task Scheduler: ${status}` };
}
