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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
   * Data directory exported as DUSKFLEET_DATA (see `exportedDataDir`): set when the installing
   * process got it from a variable the service does not see (DUSKFLEET_DATA, XDG_DATA_HOME), or
   * the service would open another database than the CLI and the dashboard. Null or absent: the
   * service resolves it like the CLI does.
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
  /**
   * macOS only: run `serve` under `caffeinate -i -s` so the Mac does not idle-sleep (and, on AC,
   * does not system-sleep) while the service is loaded. Default true; `--no-keep-awake` = false.
   * Linux and Windows have no equivalent in the unit: the notes print how to disable sleep.
   */
  keepAwake?: boolean;
}

export interface ServiceUnit {
  platform: ServicePlatform;
  label: string;
  unitPath: string;
  content: string;
  /** The unit keeps the machine awake (macOS with caffeinate in front of serve). */
  keepAwake: boolean;
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
  /** What to do instead of install-service, when it cannot work here (Linux without a user bus). */
  advice?: string;
}

const LAUNCHD_LABEL = "com.duskfleet.scheduler";
const SYSTEMD_UNIT = "duskfleet.service";
const WINDOWS_TASK = "Duskfleet Scheduler";
/** `-i` prevents idle sleep, `-s` system sleep (honoured on AC power only, by design). */
export const CAFFEINATE = "/usr/bin/caffeinate";
export const CAFFEINATE_ARGS = ["-i", "-s"];

const LINUX_SLEEP_HINT =
  "While the machine sleeps nothing runs and missed ticks are not caught up. To keep it awake, disable sleep in the desktop's power settings or with `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.";
const LINUX_LINGER_HINT =
  "Run `loginctl enable-linger $USER` once, or the service stops when you log out and only starts again at your next login.";
const LINUX_NO_BUS_HINT =
  "On a systemd machine reached over SSH, `loginctl enable-linger $USER` starts your user manager (log in again afterwards). In a container, WSL without systemd or any box without a user manager, keep `duskfleet serve` running in a terminal, tmux or your own supervisor instead.";
const WINDOWS_SLEEP_HINT =
  'While the PC sleeps nothing runs and missed ticks are not caught up. To keep it awake on AC power, set Settings > System > Power > Sleep to "Never" (or `powercfg /change standby-timeout-ac 0`).';

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

// Where the service runs, which config and data directory it must be told about: shared with
// the MCP host entry (`mcp register`, the dashboard's /mcp page), so they live in core.
export { exportedDataDir, serviceDirs } from "@duskfleet/core";

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
    const keepAwake = t.keepAwake !== false;
    const program = [...(keepAwake ? [CAFFEINATE, ...CAFFEINATE_ARGS] : []), t.nodeBin, t.cliEntry, "serve"];
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...program.map((a) => `    <string>${xml(a)}</string>`),
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
      keepAwake,
      installCommands: [
        `launchctl bootout ${domain}/${LAUNCHD_LABEL} 2>/dev/null`,
        `launchctl bootstrap ${domain} "${unitPath}"`,
        `launchctl kickstart -k ${domain}/${LAUNCHD_LABEL}`,
      ],
      uninstallCommands: [`launchctl bootout ${domain}/${LAUNCHD_LABEL}`, `rm "${unitPath}"`],
      notes: [
        "A LaunchAgent runs in your login session, so the service sees the same `claude` login as your terminal.",
        "The service starts at login and is restarted if it dies. While the Mac sleeps nothing runs; missed ticks are not caught up.",
        keepAwake
          ? "Keep-awake: serve runs under `caffeinate -i -s`, so the Mac does not sleep while the service is loaded and on AC power. On battery `-s` is ignored by design and the Mac may still sleep: keep it plugged in overnight."
          : "Keep-awake is off (--no-keep-awake): the Mac may idle-sleep and every run due meanwhile is skipped. Run install-service without --no-keep-awake to wrap serve in caffeinate.",
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
      keepAwake: false,
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
        LINUX_LINGER_HINT,
        LINUX_SLEEP_HINT,
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
    keepAwake: false,
    installCommands: [
      `schtasks /Create /F /TN "${WINDOWS_TASK}" /XML "${unitPath}"`,
      `schtasks /Run /TN "${WINDOWS_TASK}"`,
    ],
    uninstallCommands: [`schtasks /End /TN "${WINDOWS_TASK}"`, `schtasks /Delete /F /TN "${WINDOWS_TASK}"`],
    notes: [
      "A logon task in Task Scheduler runs as you, so the service sees the same `claude` login as your terminal.",
      "The task starts at logon, has no time limit and is restarted on failure. A console window may flash briefly at logon.",
      "After every `npm run build` run install-service again to restart the task with the new code.",
      WINDOWS_SLEEP_HINT,
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

/**
 * systemd --user needs a user manager and its bus (missing in containers, WSL without systemd,
 * some SSH sessions). `show-environment` is the cheapest call that talks to it.
 */
function userBusError(exec: Exec): string | null {
  const r = exec("systemctl", ["--user", "show-environment"]);
  return r.status === 0 ? null : (r.stderr || r.stdout).trim() || `exit ${r.status}`;
}

function assertUserBus(exec: Exec): void {
  const err = userBusError(exec);
  if (err) {
    throw new Error(`install-service: no systemd user bus (${err}); nothing was written. ${LINUX_NO_BUS_HINT}`);
  }
}

/** Put back the unit file an install overwrote, or remove the one it created. */
function restoreUnit(unitPath: string, previous: Buffer | null): void {
  if (previous) writeFileSync(unitPath, previous, { mode: 0o644 });
  else rmSync(unitPath, { force: true });
}

/** Write the unit and (re)start the service. Idempotent: a loaded service is restarted with the new unit. */
export function installService(t: ServiceTarget, exec: Exec = realExec): { unit: ServiceUnit; ran: string[] } {
  const unit = renderService(t);
  if (unit.platform === "linux") assertUserBus(exec);
  mkdirSync(path.dirname(t.logPath), { recursive: true });
  const previous = existsSync(unit.unitPath) ? readFileSync(unit.unitPath) : null;
  writeUnit(unit);
  const ran: string[] = [];
  if (unit.platform === "darwin") {
    const d = launchdDomain();
    exec("launchctl", ["bootout", `${d}/${unit.label}`]); // not loaded yet: fine
    ran.push(`launchctl bootout ${d}/${unit.label}`);
    must(exec, "launchctl", ["bootstrap", d, unit.unitPath], "launchctl bootstrap");
    ran.push(`launchctl bootstrap ${d} ${unit.unitPath}`);
  } else if (unit.platform === "linux") {
    try {
      must(exec, "systemctl", ["--user", "daemon-reload"], "systemctl daemon-reload");
    } catch (err) {
      // A unit systemd never loaded would make doctor report a service that cannot run.
      restoreUnit(unit.unitPath, previous);
      throw new Error(`${(err as Error).message}. ${LINUX_NO_BUS_HINT}`);
    }
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
    // A unit file systemd cannot load is not an installed service: it never runs.
    const present = existsSync(unitPath);
    if (r.status !== 0) {
      const err = (r.stderr || r.stdout).trim() || `exit ${r.status}`;
      return {
        ...base,
        installed: false,
        running: null,
        pid: null,
        detail: `${present ? "unit present, not loaded: " : ""}systemd user bus unreachable (${err})`,
        advice: LINUX_NO_BUS_HINT,
      };
    }
    const prop = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1]?.trim() ?? "";
    const loaded = prop("LoadState") === "loaded";
    const pid = Number(prop("MainPID"));
    return {
      ...base,
      installed: loaded,
      running: prop("ActiveState") === "active",
      pid: pid > 0 ? pid : null,
      detail: loaded
        ? `systemd: ${prop("ActiveState")} (${prop("SubState")})`
        : present
          ? "unit present, not loaded: run install-service"
          : "not installed",
    };
  }
  const r = exec("schtasks", ["/Query", "/TN", label, "/FO", "LIST", "/V"]);
  if (r.status !== 0) return { ...base, installed: false, running: false, pid: null, detail: "not installed" };
  const status = /^Status:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() ?? "unknown";
  return { ...base, installed: true, running: /running/i.test(status), pid: null, detail: `Task Scheduler: ${status}` };
}

// ---- keeping the machine awake ------------------------------------------------

export interface KeepAwakeStatus {
  /** The service unit runs serve under caffeinate. null = no unit installed, nothing to tell. */
  wrapsCaffeinate: boolean | null;
  /** `pmset -g` values in minutes (0 = never); null when unreadable. */
  sleepMinutes: number | null;
  diskSleepMinutes: number | null;
  advice: string | null;
}

function pmsetValue(out: string, key: string): number | null {
  const m = new RegExp(`^\\s*${key}\\s+(\\d+)`, "m").exec(out);
  return m ? Number(m[1]) : null;
}

/**
 * macOS: does the installed service keep the Mac awake, and when would the Mac sleep otherwise.
 * Reads the loaded job (`launchctl print`, its `program` line), else the plist on disk. Never throws.
 */
export function keepAwakeStatus(exec: Exec = realExec, home = homedir()): KeepAwakeStatus {
  let wraps: boolean | null = null;
  const loaded = exec("launchctl", ["print", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  if (loaded.status === 0) {
    const program = /^\s*program = (.+)$/m.exec(loaded.stdout)?.[1]?.trim();
    wraps = program ? path.basename(program) === "caffeinate" : loaded.stdout.includes(CAFFEINATE);
  } else {
    const unitPath = serviceUnitPath("darwin", home);
    if (unitPath && existsSync(unitPath)) {
      try {
        wraps = readFileSync(unitPath, "utf8").includes(`<string>${CAFFEINATE}</string>`);
      } catch {
        wraps = null;
      }
    }
  }
  const pm = exec("pmset", ["-g"]);
  const sleepMinutes = pm.status === 0 ? pmsetValue(pm.stdout, "sleep") : null;
  const diskSleepMinutes = pm.status === 0 ? pmsetValue(pm.stdout, "disksleep") : null;
  const sleeps = sleepMinutes !== 0 ? `after ${sleepMinutes ?? "?"} min idle` : null;
  let advice: string | null = null;
  if (wraps === false) {
    advice = `the service does not keep the Mac awake${sleeps ? ` (it sleeps ${sleeps})` : ""}: scheduled runs are skipped while it sleeps; run "duskfleet install-service" (keep-awake is the default)`;
  } else if (wraps && sleeps) {
    advice = `caffeinate keeps the Mac awake on AC power only; on battery it still sleeps ${sleeps}`;
  }
  return { wrapsCaffeinate: wraps, sleepMinutes, diskSleepMinutes, advice };
}

/**
 * `serve` on macOS not started under caffeinate (by hand, or a unit installed with
 * --no-keep-awake or before keep-awake existed): the one warning it logs at start. Null otherwise.
 */
export function serveSleepWarning(platform: NodeJS.Platform, ppid: number, exec: Exec = realExec): string | null {
  if (platform !== "darwin") return null;
  const r = exec("ps", ["-o", "comm=", "-p", String(ppid)]);
  if (r.status === 0 && path.basename(r.stdout.trim()) === "caffeinate") return null;
  return "duskfleet serve: warning: not running under caffeinate, the machine may sleep and skip scheduled runs; install-service --keep-awake";
}
